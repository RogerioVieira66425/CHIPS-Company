'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db.js');

const PORTA = Number(process.env.PORT) || 3000;
const DIAS_SESSAO = 7;
const PRODUCAO = process.env.NODE_ENV === 'production';
const ENDERECO = PRODUCAO ? '0.0.0.0' : '127.0.0.1';

/* ---------- limite de tentativas de login ---------- */
const JANELA_TENTATIVAS = 15 * 60 * 1000;
const MAX_TENTATIVAS = 8;
const tentativas = new Map();

function chaveTentativa(req, email) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  return ip + '|' + email;
}
function bloqueado(chave) {
  const reg = tentativas.get(chave);
  if (!reg) return false;
  if (Date.now() - reg.desde > JANELA_TENTATIVAS) { tentativas.delete(chave); return false; }
  return reg.contagem >= MAX_TENTATIVAS;
}
function registrarFalha(chave) {
  const reg = tentativas.get(chave);
  if (!reg || Date.now() - reg.desde > JANELA_TENTATIVAS) tentativas.set(chave, { contagem: 1, desde: Date.now() });
  else reg.contagem += 1;
}

function cookieSessao(token) {
  return 'sid=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + DIAS_SESSAO * 86400 + (PRODUCAO ? '; Secure' : '');
}

/* ---------- senhas ---------- */
function hashSenha(senha, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { hash, salt };
}
function senhaConfere(senha, hash, salt) {
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(senha, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- conta de administrador ----------
   Criada no primeiro boot. Troque a senha definindo ADMIN_SENHA nas variaveis
   de ambiente (no Render: Environment -> Add Environment Variable). */
const ADMIN_LOGIN = String(process.env.ADMIN_LOGIN || 'admin').toLowerCase().trim();
const ADMIN_SENHA = String(process.env.ADMIN_SENHA || 'admin');

function garantirAdmin() {
  const existente = db.prepare('SELECT id, admin FROM usuarios WHERE email = ?').get(ADMIN_LOGIN);
  if (existente) {
    if (!existente.admin) db.prepare('UPDATE usuarios SET admin = 1 WHERE id = ?').run(existente.id);
    if (process.env.ADMIN_SENHA) {
      const { hash, salt } = hashSenha(ADMIN_SENHA);
      db.prepare('UPDATE usuarios SET senha_hash = ?, salt = ? WHERE id = ?').run(hash, salt, existente.id);
    }
    return;
  }
  const { hash, salt } = hashSenha(ADMIN_SENHA);
  db.prepare('INSERT INTO usuarios (email, nome, senha_hash, salt, criado_em, admin) VALUES (?,?,?,?,?,1)')
    .run(ADMIN_LOGIN, 'Administrador', hash, salt, new Date().toISOString());
  console.log('  Conta de administrador criada: login "' + ADMIN_LOGIN + '"' +
    (process.env.ADMIN_SENHA ? '' : ' / senha "admin" (defina ADMIN_SENHA para trocar)'));
}

/* ---------- sessoes ---------- */
function criarSessao(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = Date.now() + DIAS_SESSAO * 864e5;
  db.prepare('INSERT INTO sessoes (token, user_id, expira_em) VALUES (?,?,?)').run(token, userId, expira);
  return token;
}
function usuarioDaRequisicao(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  if (!m) return null;
  const s = db.prepare('SELECT * FROM sessoes WHERE token = ?').get(m[1]);
  if (!s) return null;
  if (s.expira_em < Date.now()) {
    db.prepare('DELETE FROM sessoes WHERE token = ?').run(m[1]);
    return null;
  }
  const u = db.prepare('SELECT id, email, nome, admin FROM usuarios WHERE id = ?').get(s.user_id);
  return u ? { id: u.id, email: u.email, nome: u.nome, admin: !!u.admin, token: m[1] } : null;
}

/* ---------- coletores e analise ---------- */
// Token do agente coletor local (veja agente.js). Sem ele, a ingestao fica desligada.
const COLETOR_TOKEN = String(process.env.COLETOR_TOKEN || '').trim();
let cacheDiagnostico = { quando: 0, dados: null };
// Quando o agente local esta ativo, ele atende as buscas: tem mais lojas que o servidor.
let ultimoSinalDoAgente = 0;
const AGENTE_ATIVO_MS = 60000;
const agenteAtivo = () => Date.now() - ultimoSinalDoAgente < AGENTE_ATIVO_MS;
const coletores = [
  require('./coletores/kabum.js'),
  require('./coletores/mercadolivre.js'),
];
const analise = require('./analise.js');

/* ---------- helpers HTTP ---------- */
function json(res, status, dados) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(dados));
}
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) { req.destroy(); reject(new Error('Corpo da requisicao grande demais.')); }
    });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('JSON invalido.')); }
    });
    req.on('error', reject);
  });
}
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const num = (v) => {
  const n = Number(String(v === undefined || v === null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

/* ---------- produtos, coleta e historico ---------- */
/* A vitrine publica mostra os produtos do administrador: e o catalogo do site. */
function donoDaVitrine() {
  const admin = db.prepare('SELECT id FROM usuarios WHERE admin = 1 ORDER BY id LIMIT 1').get();
  return admin ? admin.id : 0;
}

function listarProdutos(userId) {
  const produtos = db.prepare('SELECT * FROM produtos WHERE user_id = ? ORDER BY nome').all(userId);
  return produtos.map((p) => {
    const melhor = db.prepare(
      'SELECT loja, preco_total, coletado_em, url, titulo FROM ofertas WHERE produto_id = ? ' +
      'AND coleta_id IN (SELECT c.id FROM coletas c WHERE c.produto_id = ? AND c.executado_em = ' +
    '  (SELECT MAX(c2.executado_em) FROM coletas c2 WHERE c2.produto_id = c.produto_id AND c2.fonte = c.fonte)) ' +
      'ORDER BY preco_total LIMIT 1'
    ).get(p.id, p.id);
    const total = db.prepare(
      'SELECT COUNT(*) AS n FROM ofertas WHERE produto_id = ? ' +
      'AND coleta_id IN (SELECT c.id FROM coletas c WHERE c.produto_id = ? AND c.executado_em = ' +
      '  (SELECT MAX(c2.executado_em) FROM coletas c2 WHERE c2.produto_id = c.produto_id AND c2.fonte = c.fonte))'
    ).get(p.id, p.id);
    return Object.assign({}, p, {
      menor_preco: melhor ? melhor.preco_total : 0,
      melhor_loja: melhor ? melhor.loja : '',
      melhor_url: melhor ? melhor.url : '',
      melhor_titulo: melhor ? melhor.titulo : '',
      ultima_coleta: melhor ? melhor.coletado_em : '',
      ofertas: total ? total.n : 0,
    });
  });
}

function produtoPorId(userId, id) {
  return listarProdutos(userId).find((p) => p.id === id) || null;
}

/* Serie diaria: menor preco observado em cada dia (base do grafico e do veredito). */
function historicoDiario(produtoId, dias) {
  return db.prepare(
    'SELECT substr(coletado_em, 1, 10) AS dia, MIN(preco_total) AS minimo, AVG(preco_total) AS media, COUNT(*) AS amostras ' +
    'FROM ofertas WHERE produto_id = ? GROUP BY dia ORDER BY dia DESC LIMIT ?'
  ).all(produtoId, dias || 90).reverse();
}

function detalheProduto(userId, id) {
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ? AND user_id = ?').get(id, userId);
  if (!produto) return null;

  const ultimaColeta = db.prepare(
    'SELECT * FROM coletas WHERE produto_id = ? ORDER BY executado_em DESC, id DESC LIMIT 1'
  ).get(id);

  // ofertas da coleta mais recente de cada fonte
  const ofertas = db.prepare(
    'SELECT * FROM ofertas WHERE produto_id = ? ' +
    'AND coleta_id IN (SELECT c.id FROM coletas c WHERE c.produto_id = ? AND c.executado_em = ' +
    '  (SELECT MAX(c2.executado_em) FROM coletas c2 WHERE c2.produto_id = c.produto_id AND c2.fonte = c.fonte)) ' +
    'ORDER BY preco_total'
  ).all(id, id);

  const historico = historicoDiario(id, 90);
  const comparacao = analise.compararLojas(ofertas);
  const momento = analise.avaliarMomento(comparacao.melhor ? comparacao.melhor.preco_total : 0, historico);

  return {
    produto,
    ofertas,
    comparacao,
    historico,
    momento,
    ultima_coleta: ultimaColeta || null,
    alvo_atingido: produto.preco_alvo > 0 && comparacao.melhor ? comparacao.melhor.preco_total <= produto.preco_alvo : false,
  };
}

/* Executa todos os coletores configurados e grava o resultado. */
async function coletarPrecos(userId, produto) {
  const agora = new Date().toISOString();
  const relatorio = [];

  for (const coletor of coletores) {
    if (!coletor.configurado()) {
      relatorio.push({ fonte: coletor.nome, encontrados: 0, erro: 'Fonte nao configurada.' });
      continue;
    }
    let ofertas = [];
    let erro = '';
    try {
      ofertas = await coletor.buscar(produto.termo);
    } catch (e) {
      erro = e.message;
    }

    const coleta = db.prepare(
      'INSERT INTO coletas (produto_id, user_id, fonte, executado_em, encontrados, erro) VALUES (?,?,?,?,?,?)'
    ).run(produto.id, userId, coletor.nome, agora, ofertas.length, erro);

    const inserir = db.prepare(
      'INSERT INTO ofertas (coleta_id, produto_id, user_id, loja, titulo, preco, preco_de, frete, preco_total, condicao, vendedor, reputacao, vendidos, parcelas, url, id_externo, manual, coletado_em) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)'
    );
    ofertas.forEach((o) => {
      inserir.run(
        Number(coleta.lastInsertRowid), produto.id, userId, o.loja, o.titulo, o.preco, Number(o.preco_de) || 0,
        o.frete, o.preco_total, o.condicao, o.vendedor, o.reputacao, o.vendidos, o.parcelas, o.url, o.id_externo, agora
      );
    });

    relatorio.push({ fonte: coletor.nome, encontrados: ofertas.length, erro });
  }

  db.prepare('UPDATE produtos SET atualizado_em = ? WHERE id = ?').run(agora, produto.id);
  return { executado_em: agora, relatorio };
}

/* ---------- buscas publicas (fila) ----------
   O visitante pede uma busca; quem executa e quem alcancar as lojas:
   o proprio servidor (quando roda em rede brasileira) ou o agente local. */
const VALIDADE_BUSCA_MS = 30 * 60 * 1000; // resultado vale 30 minutos

function normalizarTermo(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

function formatarBusca(linha) {
  let resultado = null;
  try { resultado = linha.resultado ? JSON.parse(linha.resultado) : null; } catch { resultado = null; }
  return {
    id: linha.id,
    termo: linha.termo,
    status: linha.status,
    erro: linha.erro,
    origem: linha.origem,
    criado_em: linha.criado_em,
    atualizado_em: linha.atualizado_em,
    resultado,
  };
}

function buscaRecente(termo) {
  const linha = db.prepare(
    "SELECT * FROM buscas WHERE termo = ? AND status = 'pronta' ORDER BY atualizado_em DESC LIMIT 1"
  ).get(termo);
  if (!linha) return null;
  return Date.now() - new Date(linha.atualizado_em).getTime() < VALIDADE_BUSCA_MS ? linha : null;
}

/* Tenta executar aqui mesmo. Devolve true quando conseguiu falar com alguma loja. */
async function executarBuscaLocalmente(id, termo) {
  const inicio = Date.now();

  // as lojas sao consultadas ao mesmo tempo: sao sites diferentes
  const fontes = await Promise.all(coletores.map(async (coletor) => {
    if (!coletor.configurado()) {
      return { fonte: coletor.nome, erro: 'Fonte nao configurada.', ofertas: [], ms: 0 };
    }
    const t = Date.now();
    try {
      return { fonte: coletor.nome, erro: '', ofertas: await coletor.buscar(termo), ms: Date.now() - t };
    } catch (e) {
      return { fonte: coletor.nome, erro: e.message, ofertas: [], ms: Date.now() - t };
    }
  }));

  if (!fontes.some((f) => !f.erro)) return false;
  const duracao = Date.now() - inicio;

  const todas = fontes.reduce((acc, f) => acc.concat(f.ofertas), []);
  const filtrado = analise.filtrarRelevantes(todas, termo);
  const resultado = {
    fontes,
    comparacao: analise.compararLojas(filtrado.ofertas),
    relevantes: filtrado.ofertas.length,
    total_bruto: todas.length,
    poucas_correspondencias: Boolean(filtrado.poucasCorrespondencias),
    duracao_ms: duracao,
  };
  db.prepare("UPDATE buscas SET status = 'pronta', resultado = ?, erro = '', origem = 'servidor', atualizado_em = ? WHERE id = ?")
    .run(JSON.stringify(resultado), new Date().toISOString(), id);
  return true;
}

/* ---------- metricas de operacao (capitulo de resultados do TCC) ---------- */
function calcularMetricas() {
  const buscas = db.prepare(
    "SELECT termo, status, origem, resultado, criado_em, atualizado_em FROM buscas ORDER BY id DESC LIMIT 500"
  ).all();

  const porLoja = new Map();
  const duracoes = [];
  let ofertasBrutas = 0;
  let ofertasRelevantes = 0;
  let prontas = 0;

  const registrar = (loja) => {
    if (!porLoja.has(loja)) {
      porLoja.set(loja, { loja, consultas: 0, sucessos: 0, falhas: 0, ofertas: 0, ms_total: 0, ultimo_erro: '' });
    }
    return porLoja.get(loja);
  };

  buscas.forEach((b) => {
    if (b.status === 'pronta') prontas += 1;
    let r = null;
    try { r = b.resultado ? JSON.parse(b.resultado) : null; } catch { r = null; }
    if (!r) return;

    if (r.duracao_ms) duracoes.push(r.duracao_ms);
    ofertasBrutas += Number(r.total_bruto) || 0;
    ofertasRelevantes += Number(r.relevantes) || 0;

    (r.fontes || []).forEach((f) => {
      // fonte sem credencial/desligada nao conta como consulta
      if (/nao configurada/i.test(f.erro || '')) return;
      const reg = registrar(f.fonte);
      reg.consultas += 1;
      reg.ms_total += Number(f.ms) || 0;
      if (f.erro) {
        reg.falhas += 1;
        reg.ultimo_erro = f.erro.slice(0, 120);
      } else {
        reg.sucessos += 1;
        reg.ofertas += (f.ofertas || []).length;
      }
    });
  });

  const lojas = [...porLoja.values()]
    .map((l) => ({
      loja: l.loja,
      consultas: l.consultas,
      sucessos: l.sucessos,
      falhas: l.falhas,
      taxa_sucesso: l.consultas ? (l.sucessos / l.consultas) * 100 : 0,
      ofertas: l.ofertas,
      media_ofertas: l.sucessos ? l.ofertas / l.sucessos : 0,
      tempo_medio_s: l.consultas ? l.ms_total / l.consultas / 1000 : 0,
      ultimo_erro: l.ultimo_erro,
    }))
    .sort((a, b) => b.ofertas - a.ofertas);

  const ordenadas = duracoes.slice().sort((a, b) => a - b);
  const mediana = ordenadas.length
    ? (ordenadas.length % 2
      ? ordenadas[(ordenadas.length - 1) / 2]
      : (ordenadas[ordenadas.length / 2 - 1] + ordenadas[ordenadas.length / 2]) / 2)
    : 0;

  const porDia = db.prepare(
    "SELECT substr(criado_em, 1, 10) AS dia, COUNT(*) AS buscas FROM buscas GROUP BY dia ORDER BY dia DESC LIMIT 30"
  ).all().reverse();

  const termos = db.prepare(
    "SELECT termo, COUNT(*) AS vezes FROM buscas GROUP BY termo ORDER BY vezes DESC, MAX(id) DESC LIMIT 10"
  ).all();

  return {
    buscas_total: db.prepare('SELECT COUNT(*) AS n FROM buscas').get().n,
    buscas_analisadas: buscas.length,
    buscas_prontas: prontas,
    tempo_medio_s: duracoes.length ? duracoes.reduce((a, b) => a + b, 0) / duracoes.length / 1000 : 0,
    tempo_mediano_s: mediana / 1000,
    ofertas_brutas: ofertasBrutas,
    ofertas_relevantes: ofertasRelevantes,
    descartadas_pct: ofertasBrutas ? ((ofertasBrutas - ofertasRelevantes) / ofertasBrutas) * 100 : 0,
    lojas,
    por_dia: porDia,
    termos,
    produtos_monitorados: db.prepare('SELECT COUNT(*) AS n FROM produtos').get().n,
    ofertas_historico: db.prepare('SELECT COUNT(*) AS n FROM ofertas').get().n,
  };
}

/* ---------- rotas ---------- */
async function api(req, res, rota) {
  const metodo = req.method;

  /* ----- diagnostico publico: as fontes respondem a partir deste servidor? ----- */
  if (rota === '/api/diagnostico' && metodo === 'GET') {
    const agora = Date.now();
    if (cacheDiagnostico.dados && agora - cacheDiagnostico.quando < 5 * 60 * 1000) {
      return json(res, 200, cacheDiagnostico.dados);
    }
    const fontes = [];
    for (const coletor of coletores) {
      if (!coletor.configurado()) {
        fontes.push({ fonte: coletor.nome, ok: false, mensagem: 'Sem credenciais configuradas.' });
        continue;
      }
      try {
        const ofertas = await coletor.buscar('mouse gamer');
        fontes.push({ fonte: coletor.nome, ok: true, mensagem: ofertas.length + ' oferta(s) na consulta de teste.' });
      } catch (e) {
        fontes.push({ fonte: coletor.nome, ok: false, mensagem: e.message });
      }
    }
    cacheDiagnostico = { quando: agora, dados: { verificado_em: new Date().toISOString(), fontes } };
    return json(res, 200, cacheDiagnostico.dados);
  }

  /* ----- ingestao pelo agente coletor local -----
     O agente roda no computador do usuario (rede brasileira), consulta as lojas
     e envia o resultado para ca. Autentica com o header X-Coletor-Token. */
  if (rota.indexOf('/api/ingestao') === 0) {
    if (!COLETOR_TOKEN) return json(res, 503, { erro: 'Ingestao desativada: defina COLETOR_TOKEN no servidor.' });
    const enviado = String(req.headers['x-coletor-token'] || '');
    if (enviado.length !== COLETOR_TOKEN.length ||
        !crypto.timingSafeEqual(Buffer.from(enviado), Buffer.from(COLETOR_TOKEN))) {
      return json(res, 401, { erro: 'Token do coletor invalido.' });
    }

    /* fila de buscas pedidas pelos visitantes */
    if (rota === '/api/ingestao/buscas' && metodo === 'GET') {
      ultimoSinalDoAgente = Date.now();
      const linhas = db.prepare(
        "SELECT id, termo FROM buscas WHERE status = 'pendente' ORDER BY id LIMIT 10"
      ).all();
      const agora = new Date().toISOString();
      linhas.forEach((b) => {
        db.prepare("UPDATE buscas SET status = 'executando', atualizado_em = ? WHERE id = ?").run(agora, b.id);
      });
      return json(res, 200, linhas);
    }

    let mIng = rota.match(/^\/api\/ingestao\/buscas\/(\d+)$/);
    if (mIng && metodo === 'POST') {
      const id = Number(mIng[1]);
      const linha = db.prepare('SELECT * FROM buscas WHERE id = ?').get(id);
      if (!linha) return json(res, 404, { erro: 'Busca nao encontrada.' });

      const c = await lerCorpo(req);
      const fontes = Array.isArray(c.fontes) ? c.fontes : [];
      const todas = fontes.reduce((acc, f) => acc.concat(Array.isArray(f.ofertas) ? f.ofertas : []), []);
      const filtrado = analise.filtrarRelevantes(todas, linha.termo);
      const encontrou = filtrado.ofertas.length > 0;
      const resultado = {
        fontes,
        comparacao: analise.compararLojas(filtrado.ofertas),
        relevantes: filtrado.ofertas.length,
        total_bruto: todas.length,
        poucas_correspondencias: Boolean(filtrado.poucasCorrespondencias),
        duracao_ms: Number(c.duracao_ms) || 0,
      };

      db.prepare('UPDATE buscas SET status = ?, resultado = ?, erro = ?, origem = ?, atualizado_em = ? WHERE id = ?')
        .run(
          encontrou || !c.erro ? 'pronta' : 'falhou',
          JSON.stringify(resultado),
          String(c.erro || ''),
          'agente',
          new Date().toISOString(),
          id
        );
      return json(res, 200, { ok: true, ofertas: todas.length });
    }

    if (rota === '/api/ingestao/pendentes' && metodo === 'GET') {
      const linhas = db.prepare('SELECT id, user_id, nome, termo FROM produtos ORDER BY id').all();
      return json(res, 200, linhas);
    }

    /* cria (ou reaproveita) um produto no dono indicado, para espelhar o que
       existe no servidor local. Sem dono informado, usa o administrador. */
    if (rota === '/api/ingestao/produtos' && metodo === 'POST') {
      const c = await lerCorpo(req);
      const nome = String(c.nome || '').trim();
      const termo = String(c.termo || '').trim() || nome;
      if (!nome) return json(res, 400, { erro: 'Informe o nome do produto.' });

      let dono = null;
      if (c.email) dono = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(String(c.email).toLowerCase().trim());
      if (!dono) dono = db.prepare('SELECT id FROM usuarios WHERE admin = 1 ORDER BY id LIMIT 1').get();
      if (!dono) return json(res, 400, { erro: 'Nenhum usuario para receber o produto.' });

      const existente = db.prepare('SELECT * FROM produtos WHERE user_id = ? AND termo = ?').get(dono.id, termo);
      if (existente) return json(res, 200, { criado: false, produto: existente });

      const agora = new Date().toISOString();
      const info = db.prepare(
        'INSERT INTO produtos (user_id, nome, termo, categoria, preco_alvo, criado_em, atualizado_em) VALUES (?,?,?,?,?,?,?)'
      ).run(dono.id, nome, termo, String(c.categoria || 'Outros'), num(c.preco_alvo) || 0, agora, agora);
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(Number(info.lastInsertRowid));
      return json(res, 201, { criado: true, produto });
    }

    if (rota === '/api/ingestao' && metodo === 'POST') {
      const corpo = await lerCorpo(req);
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(Number(corpo.produto_id));
      if (!produto) return json(res, 404, { erro: 'Produto nao encontrado.' });
      const fonte = String(corpo.fonte || '').trim();
      if (!fonte) return json(res, 400, { erro: 'Informe a fonte.' });

      const ofertas = Array.isArray(corpo.ofertas) ? corpo.ofertas : [];
      const agora = new Date().toISOString();
      const coleta = db.prepare(
        'INSERT INTO coletas (produto_id, user_id, fonte, executado_em, encontrados, erro) VALUES (?,?,?,?,?,?)'
      ).run(produto.id, produto.user_id, fonte, agora, ofertas.length, String(corpo.erro || ''));

      const inserir = db.prepare(
        'INSERT INTO ofertas (coleta_id, produto_id, user_id, loja, titulo, preco, preco_de, frete, preco_total, condicao, vendedor, reputacao, vendidos, parcelas, url, id_externo, manual, coletado_em) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)'
      );
      let gravadas = 0;
      ofertas.forEach((o) => {
        const preco = num(o.preco);
        const frete = num(o.frete) || 0;
        if (!Number.isFinite(preco) || preco <= 0) return;
        inserir.run(
          Number(coleta.lastInsertRowid), produto.id, produto.user_id,
          String(o.loja || fonte), String(o.titulo || ''), preco, num(o.preco_de) || 0, frete, preco + frete,
          o.condicao === 'usado' ? 'usado' : 'novo', String(o.vendedor || ''), String(o.reputacao || ''),
          Number(o.vendidos) || 0, Number(o.parcelas) || 0, String(o.url || ''), String(o.id_externo || ''), agora
        );
        gravadas += 1;
      });

      db.prepare('UPDATE produtos SET atualizado_em = ? WHERE id = ?').run(agora, produto.id);
      return json(res, 201, { ok: true, produto: produto.nome, fonte, gravadas });
    }

    return json(res, 404, { erro: 'Rota de ingestao nao encontrada.' });
  }

  if (rota === '/api/registrar' && metodo === 'POST') {
    const { nome, email, senha } = await lerCorpo(req);
    if (!nome || !email || !senha) return json(res, 400, { erro: 'Preencha nome, e-mail e senha.' });
    if (String(senha).length < 8) return json(res, 400, { erro: 'A senha precisa ter ao menos 8 caracteres.' });
    const mail = String(email).toLowerCase().trim();
    if (db.prepare('SELECT id FROM usuarios WHERE email = ?').get(mail)) {
      return json(res, 409, { erro: 'Este e-mail ja esta cadastrado.' });
    }
    const { hash, salt } = hashSenha(String(senha));
    const info = db.prepare('INSERT INTO usuarios (email, nome, senha_hash, salt, criado_em) VALUES (?,?,?,?,?)')
      .run(mail, String(nome).trim(), hash, salt, new Date().toISOString());
    const token = criarSessao(Number(info.lastInsertRowid));
    res.setHeader('Set-Cookie', cookieSessao(token));
    return json(res, 201, { nome, email: mail, admin: false });
  }

  if (rota === '/api/login' && metodo === 'POST') {
    const { email, senha } = await lerCorpo(req);
    const mail = String(email || '').toLowerCase().trim();
    const chave = chaveTentativa(req, mail);
    if (bloqueado(chave)) {
      return json(res, 429, { erro: 'Muitas tentativas. Tente de novo daqui a 15 minutos.' });
    }
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(mail);
    if (!u || !senhaConfere(String(senha || ''), u.senha_hash, u.salt)) {
      registrarFalha(chave);
      return json(res, 401, { erro: 'E-mail ou senha incorretos.' });
    }
    tentativas.delete(chave);
    const token = criarSessao(u.id);
    res.setHeader('Set-Cookie', cookieSessao(token));
    return json(res, 200, { nome: u.nome, email: u.email, admin: !!u.admin });
  }

  const usuario = usuarioDaRequisicao(req);

  if (rota === '/api/logout' && metodo === 'POST') {
    if (usuario) db.prepare('DELETE FROM sessoes WHERE token = ?').run(usuario.token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (PRODUCAO ? '; Secure' : ''));
    return json(res, 200, { ok: true });
  }

  /* ---------- busca publica: qualquer visitante pode pesquisar ---------- */
  if (rota === '/api/buscas' && metodo === 'POST') {
    const { termo } = await lerCorpo(req);
    const t = normalizarTermo(termo);
    if (t.length < 2) return json(res, 400, { erro: 'Digite o que voce quer procurar.' });

    const recente = buscaRecente(t);
    if (recente) return json(res, 200, formatarBusca(recente));

    const agora = new Date().toISOString();
    const info = db.prepare(
      "INSERT INTO buscas (termo, status, resultado, erro, origem, criado_em, atualizado_em) VALUES (?,'pendente','','','',?,?)"
    ).run(t, agora, agora);
    const id = Number(info.lastInsertRowid);

    // com agente ativo, a busca vai para a fila dele (mais lojas);
    // sem agente, o proprio servidor tenta responder na hora
    if (!agenteAtivo()) {
      try {
        await executarBuscaLocalmente(id, t);
      } catch (e) { /* segue para a fila do agente */ }
    }

    const linha = db.prepare('SELECT * FROM buscas WHERE id = ?').get(id);
    return json(res, linha.status === 'pronta' ? 200 : 202, formatarBusca(linha));
  }

  let mBusca = rota.match(/^\/api\/buscas\/(\d+)$/);
  if (mBusca && metodo === 'GET') {
    const linha = db.prepare('SELECT * FROM buscas WHERE id = ?').get(Number(mBusca[1]));
    if (!linha) return json(res, 404, { erro: 'Busca nao encontrada.' });
    return json(res, 200, formatarBusca(linha));
  }

  if (rota === '/api/metricas' && metodo === 'GET') {
    return json(res, 200, calcularMetricas());
  }

  if (rota === '/api/buscas/populares' && metodo === 'GET') {
    const linhas = db.prepare(
      "SELECT termo, MAX(atualizado_em) AS quando, COUNT(*) AS vezes FROM buscas " +
      "WHERE status = 'pronta' GROUP BY termo ORDER BY quando DESC LIMIT 12"
    ).all();
    return json(res, 200, linhas);
  }

  /* ---------- leitura publica (o site e aberto; login so para administrar) ---------- */
  if (rota === '/api/fontes' && metodo === 'GET') {
    return json(res, 200, coletores.map((c) => ({ chave: c.chave, nome: c.nome, configurado: c.configurado() })));
  }

  if (rota === '/api/produtos' && metodo === 'GET') {
    return json(res, 200, listarProdutos(usuario ? usuario.id : donoDaVitrine()));
  }

  const mPublico = rota.match(/^\/api\/produtos\/(\d+)$/);
  if (mPublico && metodo === 'GET') {
    const id = Number(mPublico[1]);
    const detalhe = detalheProduto(usuario ? usuario.id : donoDaVitrine(), id);
    if (!detalhe) return json(res, 404, { erro: 'Produto nao encontrado.' });
    return json(res, 200, detalhe);
  }

  if (!usuario) return json(res, 401, { erro: 'Nao autenticado.' });

  if (rota === '/api/eu' && metodo === 'GET') {
    return json(res, 200, { nome: usuario.nome, email: usuario.email, admin: usuario.admin });
  }

  /* ================= PRODUTOS MONITORADOS ================= */
  if (rota === '/api/produtos' && metodo === 'POST') {
    const { nome, termo, categoria, preco_alvo } = await lerCorpo(req);
    const n = String(nome || '').trim();
    if (!n) return json(res, 400, { erro: 'Informe o nome do produto.' });
    const t = String(termo || '').trim() || n;
    const alvo = num(preco_alvo) || 0;
    if (!Number.isFinite(alvo) || alvo < 0) return json(res, 400, { erro: 'Preco alvo invalido.' });
    const agora = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO produtos (user_id, nome, termo, categoria, preco_alvo, criado_em, atualizado_em) VALUES (?,?,?,?,?,?,?)'
    ).run(usuario.id, n, t, String(categoria || 'Outros'), alvo, agora, agora);
    return json(res, 201, produtoPorId(usuario.id, Number(info.lastInsertRowid)));
  }

  let m = rota.match(/^\/api\/produtos\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const produto = db.prepare('SELECT * FROM produtos WHERE id = ? AND user_id = ?').get(id, usuario.id);
    if (!produto) return json(res, 404, { erro: 'Produto nao encontrado.' });

    if (metodo === 'PATCH') {
      const c = await lerCorpo(req);
      const alvo = c.preco_alvo === undefined ? produto.preco_alvo : num(c.preco_alvo);
      if (!Number.isFinite(alvo) || alvo < 0) return json(res, 400, { erro: 'Preco alvo invalido.' });
      db.prepare('UPDATE produtos SET nome = ?, termo = ?, categoria = ?, preco_alvo = ?, atualizado_em = ? WHERE id = ?')
        .run(
          c.nome === undefined ? produto.nome : String(c.nome).trim() || produto.nome,
          c.termo === undefined ? produto.termo : String(c.termo).trim() || produto.termo,
          c.categoria === undefined ? produto.categoria : String(c.categoria),
          alvo,
          new Date().toISOString(),
          id
        );
      return json(res, 200, produtoPorId(usuario.id, id));
    }

    if (metodo === 'DELETE') {
      db.prepare('DELETE FROM ofertas WHERE produto_id = ? AND user_id = ?').run(id, usuario.id);
      db.prepare('DELETE FROM coletas WHERE produto_id = ? AND user_id = ?').run(id, usuario.id);
      db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  /* ----- coleta de precos ----- */
  m = rota.match(/^\/api\/produtos\/(\d+)\/coletar$/);
  if (m && metodo === 'POST') {
    const id = Number(m[1]);
    const produto = db.prepare('SELECT * FROM produtos WHERE id = ? AND user_id = ?').get(id, usuario.id);
    if (!produto) return json(res, 404, { erro: 'Produto nao encontrado.' });
    const resultado = await coletarPrecos(usuario.id, produto);
    return json(res, 200, Object.assign(resultado, { detalhe: detalheProduto(usuario.id, id) }));
  }

  /* ----- oferta lancada a mao (plano B e lojas sem API) ----- */
  m = rota.match(/^\/api\/produtos\/(\d+)\/ofertas$/);
  if (m && metodo === 'POST') {
    const id = Number(m[1]);
    const produto = db.prepare('SELECT * FROM produtos WHERE id = ? AND user_id = ?').get(id, usuario.id);
    if (!produto) return json(res, 404, { erro: 'Produto nao encontrado.' });

    const c = await lerCorpo(req);
    const loja = String(c.loja || '').trim();
    const preco = num(c.preco);
    const frete = num(c.frete) || 0;
    if (!loja) return json(res, 400, { erro: 'Informe a loja.' });
    if (!Number.isFinite(preco) || preco <= 0) return json(res, 400, { erro: 'Preco invalido.' });
    if (!Number.isFinite(frete) || frete < 0) return json(res, 400, { erro: 'Frete invalido.' });

    const agora = new Date().toISOString();
    const coleta = db.prepare(
      "INSERT INTO coletas (produto_id, user_id, fonte, executado_em, encontrados, erro) VALUES (?,?,?,?,1,'')"
    ).run(id, usuario.id, loja, agora);

    db.prepare(
      'INSERT INTO ofertas (coleta_id, produto_id, user_id, loja, titulo, preco, frete, preco_total, condicao, vendedor, reputacao, vendidos, parcelas, url, id_externo, manual, coletado_em) ' +
      "VALUES (?,?,?,?,?,?,?,?,?,'','',0,0,?,'',1,?)"
    ).run(
      Number(coleta.lastInsertRowid), id, usuario.id, loja, String(c.titulo || produto.nome),
      preco, frete, preco + frete, ['novo', 'usado'].indexOf(c.condicao) === -1 ? 'novo' : c.condicao,
      String(c.url || ''), agora
    );
    return json(res, 201, detalheProduto(usuario.id, id));
  }

  m = rota.match(/^\/api\/ofertas\/(\d+)$/);
  if (m && metodo === 'DELETE') {
    const info = db.prepare('DELETE FROM ofertas WHERE id = ? AND user_id = ?').run(Number(m[1]), usuario.id);
    if (!info.changes) return json(res, 404, { erro: 'Oferta nao encontrada.' });
    return json(res, 200, { ok: true });
  }

  /* ----- busca avulsa, sem salvar ----- */
  if (rota === '/api/buscar' && metodo === 'POST') {
    const { termo } = await lerCorpo(req);
    const t = String(termo || '').trim();
    if (!t) return json(res, 400, { erro: 'Informe o que voce quer buscar.' });
    const saida = [];
    for (const coletor of coletores) {
      if (!coletor.configurado()) {
        saida.push({ fonte: coletor.nome, erro: 'Fonte nao configurada.', ofertas: [] });
        continue;
      }
      try {
        saida.push({ fonte: coletor.nome, erro: '', ofertas: await coletor.buscar(t) });
      } catch (e) {
        saida.push({ fonte: coletor.nome, erro: e.message, ofertas: [] });
      }
    }
    const todas = saida.reduce((acc, f) => acc.concat(f.ofertas), []);
    return json(res, 200, { termo: t, fontes: saida, comparacao: analise.compararLojas(todas) });
  }


  /* ----- area do administrador ----- */
  if (rota.indexOf('/api/admin/') === 0) {
    if (!usuario.admin) return json(res, 403, { erro: 'Acesso restrito ao administrador.' });

    if (rota === '/api/admin/usuarios' && metodo === 'GET') {
      const linhas = db.prepare(
        'SELECT u.id, u.nome, u.email, u.admin, u.criado_em, ' +
        '  (SELECT COUNT(*) FROM produtos p WHERE p.user_id = u.id) AS produtos, ' +
        '  (SELECT COUNT(*) FROM coletas c WHERE c.user_id = u.id) AS coletas, ' +
        '  (SELECT COUNT(*) FROM ofertas o WHERE o.user_id = u.id) AS ofertas, ' +
        '  (SELECT COUNT(*) FROM sessoes s WHERE s.user_id = u.id AND s.expira_em > ?) AS sessoes ' +
        'FROM usuarios u ORDER BY u.id'
      ).all(Date.now());
      return json(res, 200, linhas.map((l) => Object.assign(l, { admin: !!l.admin })));
    }

    let ad = rota.match(/^\/api\/admin\/usuarios\/(\d+)$/);
    if (ad && metodo === 'DELETE') {
      const id = Number(ad[1]);
      if (id === usuario.id) return json(res, 400, { erro: 'Voce nao pode excluir a propria conta.' });
      const alvo = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(id);
      if (!alvo) return json(res, 404, { erro: 'Usuario nao encontrado.' });
      db.prepare('DELETE FROM ofertas WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM coletas WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM produtos WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM sessoes WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }

    ad = rota.match(/^\/api\/admin\/usuarios\/(\d+)\/senha$/);
    if (ad && metodo === 'POST') {
      const { senha } = await lerCorpo(req);
      if (String(senha || '').length < 8) return json(res, 400, { erro: 'A nova senha precisa ter ao menos 8 caracteres.' });
      const id = Number(ad[1]);
      const alvo = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(id);
      if (!alvo) return json(res, 404, { erro: 'Usuario nao encontrado.' });
      const { hash, salt } = hashSenha(String(senha));
      db.prepare('UPDATE usuarios SET senha_hash = ?, salt = ? WHERE id = ?').run(hash, salt, id);
      db.prepare('DELETE FROM sessoes WHERE user_id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { erro: 'Rota nao encontrada.' });
}

/* ---------- servidor ---------- */
const PUBLICO = path.join(__dirname, 'public');

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rota = decodeURIComponent(url.pathname);

  if (rota.indexOf('/api/') === 0) {
    api(req, res, rota).catch((e) => json(res, 400, { erro: e.message || 'Erro na requisicao.' }));
    return;
  }

  const arquivo = rota === '/' ? 'index.html' : rota.replace(/^\/+/, '');
  const destino = path.join(PUBLICO, arquivo);
  if (destino.indexOf(PUBLICO) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso negado');
    return;
  }
  fs.readFile(destino, (err, conteudo) => {
    if (err) {
      // rotas da interface (ex.: /admin) caem no index.html
      if (!path.extname(destino)) {
        fs.readFile(path.join(PUBLICO, 'index.html'), (e2, pagina) => {
          if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Pagina nao encontrada'); return; }
          res.writeHead(200, { 'Content-Type': TIPOS['.html'] });
          res.end(pagina);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Pagina nao encontrada');
      return;
    }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(destino)] || 'application/octet-stream' });
    res.end(conteudo);
  });
});

garantirAdmin();

servidor.listen(PORTA, ENDERECO, () => {
  console.log('\n  Comparador de Precos rodando em  http://localhost:' + PORTA + '\n  (Ctrl+C para parar)\n');
});
