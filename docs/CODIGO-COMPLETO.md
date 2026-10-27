# Comparador de Precos de Equipamentos Gamer — codigo-fonte completo

Anexo tecnico do TCC. Documento gerado a partir do codigo em producao.

## Arquitetura

```
  visitante (navegador)
        |  POST /api/buscas
        v
  SERVIDOR PUBLICO (Render)  --------- banco SQLite ---------+
        |                                                     |
        |  o servidor alcanca as lojas?                        |
        +-- SIM --> consulta as 6 lojas em paralelo -----------+
        |                                                      |
        +-- NAO (bloqueio de IP de nuvem)                       |
                 |  a busca fica na fila                         |
                 v                                               |
        AGENTE LOCAL (rede brasileira)                           |
          - KaBuM! por API                                       |
          - Pichau, Terabyte, Patoloco, Setup Ninja, Amazon      |
            pelo Chrome local (DevTools Protocol)                |
                 |  devolve as ofertas -------------------------+
                 v
        filtro de relevancia -> comparacao por custo ajustado
                 |
                 v
        resposta: melhor loja, ranking, link de compra
```

## Indice


**Servidor e dados**

| Arquivo | Linhas | Funcao |
|---|---:|---|
| `server.js` | 876 | Servidor HTTP, rotas da API, fila de buscas publicas, ingestao do agente e area administrativa |
| `db.js` | 99 | Banco SQLite: usuarios, sessoes, produtos, coletas, ofertas e buscas |
| `analise.js` | 204 | Regra de decisao: relevancia, deteccao de mesmo produto, custo ajustado e avaliacao do momento de compra |

**Coleta de precos**

| Arquivo | Linhas | Funcao |
|---|---:|---|
| `agente.js` | 236 | Agente que roda na maquina do usuario: atende a fila de buscas e alimenta o historico |
| `coletores/navegador.js` | 263 | Controla o Chrome local pelo DevTools Protocol, sem bibliotecas |
| `coletores/kabum.js` | 80 | KaBuM! — API publica do catalogo |
| `coletores/pichau.js` | 83 | Pichau — navegador local |
| `coletores/terabyte.js` | 73 | Terabyte — navegador local |
| `coletores/patoloco.js` | 92 | Patoloco — navegador local |
| `coletores/setupninja.js` | 82 | Setup Ninja — navegador local |
| `coletores/amazon.js` | 80 | Amazon BR — navegador local |
| `coletores/magalu.js` | 82 | Magazine Luiza — implementado, desligado (a loja bloqueia automacao) |
| `coletores/mercadolivre.js` | 117 | Mercado Livre — API oficial, bloqueada para apps nao liberados |
| `coletores/frete.js` | 161 | Frete e prazo por CEP — infraestrutura pronta, em aberto |

**Interface**

| Arquivo | Linhas | Funcao |
|---|---:|---|
| `public/index.html` | 248 | Estrutura das telas: busca, resultado, detalhe, metricas e administracao |
| `public/app.js` | 796 | Logica da interface: busca, paginacao, graficos e telas |
| `public/fundo.js` | 246 | Cena animada da capa desenhada em canvas |
| `public/estilo.css` | 524 | Visual do sistema |

**Configuracao e rotinas**

| Arquivo | Linhas | Funcao |
|---|---:|---|
| `package.json` | 15 | Scripts do projeto |
| `render.yaml` | 28 | Deploy no Render |
| `INICIAR.bat` | 5 | Sobe o sistema local |
| `ATENDER-BUSCAS.bat` | 5 | Agente em modo servico |
| `COLETA-DIARIA.bat` | 7 | Coleta diaria agendada |

Total: **4402 linhas** de codigo proprio, sem nenhuma dependencia externa.

---

# Servidor e dados

## server.js

Servidor HTTP, rotas da API, fila de buscas publicas, ingestao do agente e area administrativa

```js
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
      'INSERT INTO ofertas (coleta_id, produto_id, user_id, loja, titulo, preco, frete, preco_total, condicao, vendedor, reputacao, vendidos, parcelas, url, id_externo, manual, coletado_em) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)'
    );
    ofertas.forEach((o) => {
      inserir.run(
        Number(coleta.lastInsertRowid), produto.id, userId, o.loja, o.titulo, o.preco, o.frete, o.preco_total,
        o.condicao, o.vendedor, o.reputacao, o.vendidos, o.parcelas, o.url, o.id_externo, agora
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
        'INSERT INTO ofertas (coleta_id, produto_id, user_id, loja, titulo, preco, frete, preco_total, condicao, vendedor, reputacao, vendidos, parcelas, url, id_externo, manual, coletado_em) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)'
      );
      let gravadas = 0;
      ofertas.forEach((o) => {
        const preco = num(o.preco);
        const frete = num(o.frete) || 0;
        if (!Number.isFinite(preco) || preco <= 0) return;
        inserir.run(
          Number(coleta.lastInsertRowid), produto.id, produto.user_id,
          String(o.loja || fonte), String(o.titulo || ''), preco, frete, preco + frete,
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
```

## db.js

Banco SQLite: usuarios, sessoes, produtos, coletas, ofertas e buscas

```js
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

// Em producao (Render) aponte DB_PATH para um disco persistente, ex.: /var/data/precos.db
const CAMINHO = process.env.DB_PATH || path.join(__dirname, 'precos.db');
const db = new DatabaseSync(CAMINHO);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS usuarios (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  nome       TEXT NOT NULL,
  senha_hash TEXT NOT NULL,
  salt       TEXT NOT NULL,
  criado_em  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessoes (
  token     TEXT PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em INTEGER NOT NULL
);

-- Produtos monitorados (a "lista de desejos" de cada usuario)
CREATE TABLE IF NOT EXISTS produtos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  termo         TEXT NOT NULL,
  categoria     TEXT NOT NULL DEFAULT 'Outros',
  preco_alvo    REAL NOT NULL DEFAULT 0,
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

-- Cada execucao de busca em uma fonte (Mercado Livre, manual, ...)
CREATE TABLE IF NOT EXISTS coletas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id   INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  fonte        TEXT NOT NULL,
  executado_em TEXT NOT NULL,
  encontrados  INTEGER NOT NULL DEFAULT 0,
  erro         TEXT NOT NULL DEFAULT ''
);

-- Cada oferta observada em uma coleta (o historico de precos nasce daqui)
CREATE TABLE IF NOT EXISTS ofertas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  coleta_id    INTEGER REFERENCES coletas(id) ON DELETE CASCADE,
  produto_id   INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  loja         TEXT NOT NULL,
  titulo       TEXT NOT NULL DEFAULT '',
  preco        REAL NOT NULL,
  frete        REAL NOT NULL DEFAULT 0,
  preco_total  REAL NOT NULL,
  condicao     TEXT NOT NULL DEFAULT 'novo',
  vendedor     TEXT NOT NULL DEFAULT '',
  reputacao    TEXT NOT NULL DEFAULT '',
  vendidos     INTEGER NOT NULL DEFAULT 0,
  parcelas     INTEGER NOT NULL DEFAULT 0,
  url          TEXT NOT NULL DEFAULT '',
  id_externo   TEXT NOT NULL DEFAULT '',
  manual       INTEGER NOT NULL DEFAULT 0,
  coletado_em  TEXT NOT NULL
);

-- Buscas pedidas pelos visitantes do site publico.
-- O servidor registra o pedido; quem executa e o agente na rede brasileira.
CREATE TABLE IF NOT EXISTS buscas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  termo         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','executando','pronta','falhou')),
  resultado     TEXT NOT NULL DEFAULT '',
  erro          TEXT NOT NULL DEFAULT '',
  origem        TEXT NOT NULL DEFAULT '',
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_buscas_termo ON buscas(termo, atualizado_em);
CREATE INDEX IF NOT EXISTS idx_buscas_status ON buscas(status, id);

CREATE INDEX IF NOT EXISTS idx_ofertas_produto ON ofertas(produto_id, coletado_em);
CREATE INDEX IF NOT EXISTS idx_coletas_produto ON coletas(produto_id, executado_em);
CREATE INDEX IF NOT EXISTS idx_produtos_user ON produtos(user_id);
`);

// Coluna de administrador (adicionada depois; ALTER seguro para bancos antigos)
const colunas = db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name);
if (colunas.indexOf('admin') === -1) {
  db.exec('ALTER TABLE usuarios ADD COLUMN admin INTEGER NOT NULL DEFAULT 0');
}

module.exports = db;
```

## analise.js

Regra de decisao: relevancia, deteccao de mesmo produto, custo ajustado e avaliacao do momento de compra

```js
'use strict';
/* Regra de decisao do sistema: dadas as ofertas coletadas e o historico de precos,
   responde "em qual loja compensa comprar" e "este e um bom momento". */

const PESO_REPUTACAO = { '5_green': 0, '4_light_green': 0.01, '3_yellow': 0.03, '2_orange': 0.06, '1_red': 0.12 };
const PENALIDADE_USADO = 0.15;   // 15% de "custo de risco" para produto usado
const PENALIDADE_SEM_DADOS = 0.02;

/* Custo ajustado: preco final mais uma penalidade de risco.
   Serve para nao recomendar uma loja 2% mais barata com vendedor ruim. */
function custoAjustado(oferta) {
  let fator = 1;
  if (oferta.condicao === 'usado') fator += PENALIDADE_USADO;
  if (oferta.condicao === 'nao informado') fator += PENALIDADE_SEM_DADOS;
  const rep = oferta.reputacao ? PESO_REPUTACAO[oferta.reputacao] : PENALIDADE_SEM_DADOS;
  fator += rep === undefined ? PENALIDADE_SEM_DADOS : rep;
  return oferta.preco_total * fator;
}

/* ---------- relevancia ----------
   As lojas completam a busca com produtos parecidos: procurar "redragon kumara"
   traz teclados de outras marcas. Sem este filtro o sistema compararia produtos
   diferentes e recomendaria o mais barato de todos, que nao e o que a pessoa quer. */
const PALAVRAS_IGNORADAS = ['de', 'da', 'do', 'para', 'com', 'e', 'a', 'o', 'em', 'gamer'];

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function termosRelevantes(termo) {
  return normalizar(termo)
    .split(' ')
    .filter((t) => t.length >= 3 && PALAVRAS_IGNORADAS.indexOf(t) === -1);
}

/* Fracao dos termos da busca presentes no titulo do anuncio. */
function aderencia(titulo, termos) {
  if (!termos.length) return 1;
  const alvo = normalizar(titulo);
  const achados = termos.filter((t) => alvo.indexOf(t) !== -1).length;
  return achados / termos.length;
}

function filtrarRelevantes(ofertas, termo, minimo) {
  const termos = termosRelevantes(termo);
  if (!termos.length) return { ofertas, corte: 0 };

  const corte = typeof minimo === 'number' ? minimo : 0.7;
  const comNota = ofertas.map((o) => Object.assign({}, o, { aderencia: aderencia(o.titulo, termos) }));
  const aprovadas = comNota.filter((o) => o.aderencia >= corte);

  // se nada passou, devolve as mais parecidas em vez de uma lista vazia
  if (!aprovadas.length) {
    const melhores = comNota.sort((a, b) => b.aderencia - a.aderencia).slice(0, 5).filter((o) => o.aderencia > 0);
    return { ofertas: melhores, corte, poucasCorrespondencias: true };
  }
  return { ofertas: aprovadas, corte };
}

/* Dois anuncios falam do mesmo produto? Compara as palavras dos titulos.
   Serve para nao anunciar "economia" entre modelos diferentes. */
// palavras de categoria/marketing nao distinguem um modelo de outro
const PALAVRAS_GENERICAS = [
  'teclado', 'mouse', 'mousepad', 'headset', 'fone', 'monitor', 'cadeira', 'gabinete',
  'mecanico', 'mecanica', 'gamer', 'rgb', 'led', 'usb', 'fio', 'sem', 'com', 'wireless',
  'bluetooth', 'preto', 'branco', 'dpi', 'botoes', 'switch', 'anti', 'ghosting', 'abnt2',
  'pro', 'plus', 'rainbow', 'lightsync',
];

/* Codigo do modelo: token que mistura letra e numero (g502, k552, m724, k552rgb).
   E o que realmente identifica o produto entre lojas diferentes. */
function codigosDoTitulo(titulo) {
  return new Set(
    normalizar(titulo)
      .split(' ')
      .filter((t) => t.length >= 3 && /[a-z]/.test(t) && /\d/.test(t))
  );
}

function parecidos(a, b) {
  const ca = codigosDoTitulo(a);
  const cb = codigosDoTitulo(b);
  if (ca.size && cb.size) {
    // um dos codigos precisa aparecer nos dois (ou um conter o outro: k552 e k552rgb)
    for (const x of ca) {
      for (const y of cb) {
        if (x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0) return true;
      }
    }
    return false;
  }

  const palavras = (t) => new Set(
    normalizar(t).split(' ').filter((x) =>
      x.length >= 3 &&
      PALAVRAS_IGNORADAS.indexOf(x) === -1 &&
      PALAVRAS_GENERICAS.indexOf(x) === -1
    )
  );
  const A = palavras(a);
  const B = palavras(b);
  if (!A.size || !B.size) return false;
  let comuns = 0;
  A.forEach((x) => { if (B.has(x)) comuns += 1; });
  return comuns / Math.min(A.size, B.size) >= 0.6;
}

function mediana(valores) {
  if (!valores.length) return 0;
  const v = valores.slice().sort((a, b) => a - b);
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
}

/* Compara as ofertas da coleta mais recente e devolve o ranking por loja. */
function compararLojas(ofertas, opcoes) {
  const o = opcoes || {};
  let lista = ofertas.slice();
  if (o.somenteNovos !== false) {
    const novos = lista.filter((x) => x.condicao === 'novo');
    if (novos.length) lista = novos;
  }
  if (!lista.length) return { ranking: [], melhor: null, economia: 0, economia_pct: 0 };

  // melhor oferta de cada loja
  const porLoja = new Map();
  lista.forEach((oferta) => {
    const atual = porLoja.get(oferta.loja);
    if (!atual || oferta.preco_total < atual.preco_total) porLoja.set(oferta.loja, oferta);
  });

  const ranking = [...porLoja.values()]
    .map((oferta) => Object.assign({}, oferta, { custo_ajustado: custoAjustado(oferta) }))
    .sort((a, b) => a.custo_ajustado - b.custo_ajustado);

  const melhor = ranking[0];
  const pior = ranking[ranking.length - 1];
  const economia = pior.preco_total - melhor.preco_total;

  // As lojas podem ter devolvido modelos diferentes (comum em busca generica).
  // Nesse caso nao faz sentido falar em "economia": seria comparar produtos distintos.
  const mesmoProduto = ranking.length < 2 || ranking.every((o) => parecidos(melhor.titulo, o.titulo));

  return {
    ranking,
    melhor,
    economia: mesmoProduto ? economia : 0,
    economia_pct: mesmoProduto && pior.preco_total > 0 ? (economia / pior.preco_total) * 100 : 0,
    mesmo_produto: mesmoProduto,
    // o mais barato nem sempre e o recomendado: avisamos quando diferem
    mais_barato: ranking.slice().sort((a, b) => a.preco_total - b.preco_total)[0],
  };
}

/* Compara o preco de hoje com o historico do proprio produto. */
function avaliarMomento(precoAtual, historico) {
  const valores = historico.map((h) => h.minimo).filter((v) => v > 0);
  if (!precoAtual || valores.length < 2) {
    return {
      status: 'sem_historico',
      titulo: 'Ainda sem histórico',
      texto: 'Atualize os preços por alguns dias para o sistema avaliar se o momento é bom.',
      minimo: valores.length ? Math.min(...valores) : precoAtual,
      maximo: valores.length ? Math.max(...valores) : precoAtual,
      mediana: valores.length ? mediana(valores) : precoAtual,
      variacao_pct: 0,
      dias: valores.length,
    };
  }

  const minimo = Math.min(...valores);
  const maximo = Math.max(...valores);
  const med = mediana(valores);
  const variacao = med > 0 ? ((precoAtual - med) / med) * 100 : 0;

  let status, titulo, texto;
  if (precoAtual <= minimo) {
    status = 'otimo';
    titulo = 'Melhor preço já registrado';
    texto = 'É o menor valor desde que você começou a monitorar este produto.';
  } else if (variacao <= -5) {
    status = 'bom';
    titulo = 'Bom momento para comprar';
    texto = 'Está ' + Math.abs(variacao).toFixed(1).replace('.', ',') + '% abaixo da mediana do período.';
  } else if (variacao < 5) {
    status = 'neutro';
    titulo = 'Preço na média';
    texto = 'Está próximo da mediana histórica. Comprar agora não é vantagem nem prejuízo claro.';
  } else {
    status = 'ruim';
    titulo = 'Vale esperar';
    texto = 'Está ' + variacao.toFixed(1).replace('.', ',') + '% acima da mediana. Já esteve por ' +
      minimo.toFixed(2).replace('.', ',') + '.';
  }

  return { status, titulo, texto, minimo, maximo, mediana: med, variacao_pct: variacao, dias: valores.length };
}

module.exports = { compararLojas, avaliarMomento, custoAjustado, mediana, filtrarRelevantes, aderencia, termosRelevantes, parecidos };
```

---

# Coleta de precos

## agente.js

Agente que roda na maquina do usuario: atende a fila de buscas e alimenta o historico

```js
'use strict';
/* Agente coletor local.
   -------------------------------------------------------------------------
   Por que existe: as lojas respondem normalmente a partir de uma rede
   brasileira, mas bloqueiam servidores de nuvem no exterior (o Render fica
   nos EUA). Entao a coleta roda aqui, no seu computador, e so o resultado e
   enviado para o sistema publicado.

   Como usar (PowerShell):
     $env:SERVIDOR="http://localhost:3000,https://seu-site.onrender.com"
     $env:COLETOR_TOKEN="a-mesma-chave-configurada-no-servidor"
     node agente.js

   SERVIDOR aceita varios destinos separados por virgula: a coleta acontece
   uma unica vez e o resultado e enviado para todos. Assim o banco local
   guarda o historico completo e o site publico mostra os precos atuais.

   Para gerar um token novo:  node agente.js --token
   Para formar historico, agende este comando no Agendador de Tarefas do
   Windows (uma vez por dia ja e suficiente e evita incomodar as lojas).
   ------------------------------------------------------------------------- */

const crypto = require('node:crypto');

const SERVIDORES = String(process.env.SERVIDOR || 'http://localhost:3000')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const TOKEN = String(process.env.COLETOR_TOKEN || '').trim();
// cada consulta vai para uma loja diferente, entao a pausa entre elas pode ser curta
const PAUSA_MS = Number(process.env.PAUSA_MS) || 600;

/* O agente roda na maquina do usuario: pode usar o navegador local para as lojas
   que recusam requisicoes simples. O servidor publico usa so as fontes por API. */
const coletores = [
  require('./coletores/kabum.js'),      // API publica
  require('./coletores/pichau.js'),     // navegador
  require('./coletores/terabyte.js'),   // navegador
  require('./coletores/patoloco.js'),   // navegador
  require('./coletores/setupninja.js'), // navegador
  require('./coletores/amazon.js'),     // navegador
  require('./coletores/magalu.js'),     // desligada: a loja bloqueia
  require('./coletores/mercadolivre.js'), // desligada: exige liberacao da API
];

if (process.argv.indexOf('--token') !== -1) {
  console.log('\nToken gerado (use o MESMO valor no servidor e no agente):\n');
  console.log('  ' + crypto.randomBytes(24).toString('hex') + '\n');
  process.exit(0);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const apelido = (url) => url.replace(/^https?:\/\//, '').split('/')[0];

async function pedir(servidor, caminho, opcoes) {
  const conf = Object.assign({ headers: {} }, opcoes);
  conf.headers['X-Coletor-Token'] = TOKEN;
  if (conf.body) {
    conf.headers['Content-Type'] = 'application/json';
    conf.body = JSON.stringify(conf.body);
  }
  const r = await fetch(servidor + caminho, conf);
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || ('HTTP ' + r.status));
  return dados;
}

async function principal() {
  if (!TOKEN) {
    console.error('\n' + 'Defina COLETOR_TOKEN antes de rodar. Gere um com:  node agente.js --token' + '\n');
    process.exit(1);
  }

  console.log('\n  Agente coletor');
  console.log('  destinos: ' + SERVIDORES.map(apelido).join(', '));
  console.log('  fontes:   ' + coletores.filter((c) => c.configurado()).map((c) => c.nome).join(', ') + '\n');

  // 1) cada destino tem os proprios produtos (e os proprios ids)
  const destinos = [];
  for (const servidor of SERVIDORES) {
    try {
      const produtos = await pedir(servidor, '/api/ingestao/pendentes');
      destinos.push({ servidor, produtos });
      console.log('  ' + apelido(servidor) + ': ' + produtos.length + ' produto(s) monitorado(s)');
    } catch (e) {
      console.log('  ' + apelido(servidor) + ': indisponivel (' + e.message + ')');
    }
  }
  if (!destinos.length) {
    console.log('\n  Nenhum destino respondeu. Verifique o COLETOR_TOKEN e os enderecos.\n');
    return;
  }

  // 2) o termo de busca e o que identifica o produto entre servidores diferentes
  const termos = [...new Set(destinos.flatMap((d) => d.produtos.map((p) => p.termo)))];

  // 2b) espelha: o que existe em um destino passa a existir nos outros
  const modelo = new Map();
  destinos.forEach((d) => d.produtos.forEach((p) => { if (!modelo.has(p.termo)) modelo.set(p.termo, p); }));

  for (const destino of destinos) {
    const faltando = termos.filter((t) => !destino.produtos.some((p) => p.termo === t));
    for (const termo of faltando) {
      const base = modelo.get(termo);
      try {
        const r = await pedir(destino.servidor, '/api/ingestao/produtos', {
          method: 'POST',
          body: { nome: base.nome, termo: base.termo },
        });
        destino.produtos.push({ id: r.produto.id, nome: r.produto.nome, termo: r.produto.termo });
        if (r.criado) console.log('  ' + apelido(destino.servidor) + ': produto "' + base.nome + '" criado');
      } catch (e) {
        console.log('  ' + apelido(destino.servidor) + ': nao consegui criar "' + base.nome + '" (' + e.message + ')');
      }
    }
  }
  if (!termos.length) {
    console.log('\n  Nenhum produto monitorado. Cadastre um produto no site e rode de novo.\n');
    return;
  }

  // 3) consulta cada termo uma unica vez, mesmo que va para varios destinos
  console.log('');
  const resultados = new Map();
  for (const termo of termos) {
    console.log('  "' + termo + '"');
    resultados.set(termo, await consultarTodas(termo));
    await espera(PAUSA_MS);
  }

  // 4) envia o mesmo resultado para cada destino, usando o id de produto de la
  console.log('');
  let gravadasTotal = 0;
  for (const destino of destinos) {
    let doDestino = 0;
    for (const produto of destino.produtos) {
      for (const r of resultados.get(produto.termo) || []) {
        try {
          const resp = await pedir(destino.servidor, '/api/ingestao', {
            method: 'POST',
            body: { produto_id: produto.id, fonte: r.fonte, ofertas: r.ofertas, erro: r.erro },
          });
          doDestino += resp.gravadas;
        } catch (e) {
          console.log('  ' + apelido(destino.servidor) + ' / ' + produto.nome + ': falhou (' + e.message + ')');
        }
      }
    }
    gravadasTotal += doDestino;
    console.log('  ' + apelido(destino.servidor) + ': ' + doDestino + ' oferta(s) gravada(s)');
  }

  console.log('\n  Concluido: ' + gravadasTotal + ' gravacao(oes) em ' + destinos.length + ' destino(s).\n');
}

/* Consulta todas as lojas EM PARALELO e mede quanto cada uma levou.
   Sao sites diferentes, entao a consulta simultanea nao sobrecarrega ninguem. */
async function consultarTodas(termo) {
  const tarefas = coletores.map(async (coletor) => {
    if (!coletor.configurado()) {
      return { fonte: coletor.nome, erro: 'Fonte nao configurada.', ofertas: [], ms: 0 };
    }
    const inicio = Date.now();
    try {
      const ofertas = await coletor.buscar(termo);
      const ms = Date.now() - inicio;
      console.log('      ' + coletor.nome.padEnd(15) + ofertas.length + ' oferta(s) em ' + (ms / 1000).toFixed(1) + 's');
      return { fonte: coletor.nome, erro: '', ofertas, ms };
    } catch (e) {
      const ms = Date.now() - inicio;
      console.log('      ' + coletor.nome.padEnd(15) + 'erro: ' + e.message.slice(0, 70));
      return { fonte: coletor.nome, erro: e.message, ofertas: [], ms };
    }
  });
  return Promise.all(tarefas);
}

/* ---------- modo servico: atende as buscas pedidas no site publico ---------- */
async function atenderBuscas() {
  for (const servidor of SERVIDORES) {
    let pendentes = [];
    try {
      pendentes = await pedir(servidor, '/api/ingestao/buscas');
    } catch (e) {
      continue; // servidor fora do ar ou sem token: tenta no proximo ciclo
    }

    for (const busca of pendentes) {
      console.log('  [' + new Date().toLocaleTimeString('pt-BR') + '] busca de visitante: "' + busca.termo + '"');
      const inicio = Date.now();
      const fontes = await consultarTodas(busca.termo);
      const duracao = Date.now() - inicio;
      console.log('      total: ' + fontes.reduce((t, f) => t + f.ofertas.length, 0) + ' oferta(s) em ' + (duracao / 1000).toFixed(1) + 's');

      try {
        await pedir(servidor, '/api/ingestao/buscas/' + busca.id, {
          method: 'POST',
          body: { fontes, duracao_ms: duracao },
        });
      } catch (e) {
        console.log('      nao consegui devolver o resultado: ' + e.message);
      }
    }
  }
}

async function servico() {
  const intervalo = Number(process.env.INTERVALO_MS) || 4000;
  console.log('');
  console.log('  Agente em modo servico');
  console.log('  destinos: ' + SERVIDORES.map(apelido).join(', '));
  console.log('  atendendo buscas do site a cada ' + (intervalo / 1000) + 's. Ctrl+C para parar.');
  console.log('');
  for (;;) {
    try {
      await atenderBuscas();
    } catch (e) {
      console.log('  erro no ciclo: ' + e.message);
    }
    await espera(intervalo);
  }
}

if (process.argv.indexOf('--servico') !== -1) {
  if (!TOKEN) {
    console.error('Defina COLETOR_TOKEN antes de rodar.');
    process.exit(1);
  }
  servico();
} else {

principal().catch((e) => {
  console.error('\n  Erro: ' + e.message + '\n');
  process.exit(1);
});
}
```

## coletores/navegador.js

Controla o Chrome local pelo DevTools Protocol, sem bibliotecas

```js
'use strict';
/* Navegador headless controlado pelo protocolo DevTools do Chrome.
   -------------------------------------------------------------------------
   Varias lojas (Pichau, Terabyte, Magalu) recusam requisicoes que nao venham
   de um navegador de verdade. Em vez de instalar um navegador proprio, este
   modulo usa o Chrome que ja existe na maquina e conversa com ele via CDP
   (Chrome DevTools Protocol), usando o WebSocket nativo do Node 22+.
   Zero dependencias externas.

   So e usado pelo agente local: o servidor publico nao abre navegador. */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAMINHOS_CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function acharChrome() {
  for (const caminho of CAMINHOS_CHROME) {
    try { if (fs.existsSync(caminho)) return caminho; } catch { /* segue */ }
  }
  return '';
}

const CHROME = acharChrome();
const disponivel = () => Boolean(CHROME);

let navegador = null;     // { processo, endereco, perfil }
let abrindo = null;       // promessa em andamento: evita abrir varios Chromes de uma vez

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function abrirNavegador() {
  if (navegador) return navegador;
  // com consultas em paralelo, varias chamadas chegam juntas: todas esperam a mesma abertura
  if (abrindo) return abrindo;
  abrindo = abrirDeVerdade().finally(() => { abrindo = null; });
  return abrindo;
}

async function abrirDeVerdade() {
  if (navegador) return navegador;
  if (!CHROME) throw new Error('Chrome nao encontrado nesta maquina (defina CHROME_PATH).');

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'coletor-chrome-'));
  // Sem --headless: varias lojas detectam o modo headless e devolvem pagina de
  // manutencao. A janela abre fora da tela, entao nao atrapalha quem esta usando o PC.
  const processo = spawn(CHROME, [
    process.env.JANELA_VISIVEL === '1' ? '--window-position=40,40' : '--window-position=-32000,-32000',
    '--remote-debugging-port=0',
    '--user-data-dir=' + perfil,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--mute-audio',
    '--window-size=1366,900',
    '--lang=pt-BR',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const endereco = await new Promise((resolve, reject) => {
    let saida = '';
    const tempo = setTimeout(() => reject(new Error('Chrome nao respondeu a tempo.')), 20000);
    processo.stderr.on('data', (c) => {
      saida += c.toString();
      const m = saida.match(/ws:\/\/([^\/]+)\//);
      if (m) { clearTimeout(tempo); resolve('http://' + m[1]); }
    });
    processo.on('error', (e) => { clearTimeout(tempo); reject(e); });
    processo.on('exit', () => { clearTimeout(tempo); reject(new Error('Chrome encerrou sozinho.')); });
  });

  navegador = { processo, endereco, perfil };

  const encerrar = () => fechar();
  process.once('exit', encerrar);
  process.once('SIGINT', () => { encerrar(); process.exit(0); });

  return navegador;
}

function fechar() {
  if (!navegador) return;
  try { navegador.processo.kill(); } catch { /* ja morreu */ }
  try { fs.rmSync(navegador.perfil, { recursive: true, force: true }); } catch { /* sem problema */ }
  navegador = null;
}

/* Conversa CDP com uma aba: navega ate a url e roda o script de extracao. */
function comAba(wsUrl, url, script, esperaMs, visitarAntes, interacao) {
  return new Promise((resolve, reject) => {
    let visitaPendente = Boolean(visitarAntes);
    const socket = new WebSocket(wsUrl);
    const pendentes = new Map();
    let proximoId = 1;
    let terminou = false;

    const limite = setTimeout(() => {
      if (!terminou) { terminou = true; try { socket.close(); } catch {} reject(new Error('Tempo esgotado ao carregar a pagina.')); }
    }, 45000);

    const enviar = (metodo, params) => new Promise((ok, falha) => {
      const id = proximoId++;
      pendentes.set(id, { ok, falha });
      socket.send(JSON.stringify({ id, method: metodo, params: params || {} }));
    });

    socket.addEventListener('message', async (evento) => {
      let msg;
      try { msg = JSON.parse(evento.data); } catch { return; }

      if (msg.id && pendentes.has(msg.id)) {
        const { ok, falha } = pendentes.get(msg.id);
        pendentes.delete(msg.id);
        if (msg.error) falha(new Error(msg.error.message || 'erro do navegador'));
        else ok(msg.result);
        return;
      }

      if (msg.method === 'Page.loadEventFired' && !terminou) {
        // quando pedido, a primeira carga e so a "visita previa" (pega cookies da loja)
        if (visitaPendente) {
          visitaPendente = false;
          await esperar(2000);
          enviar('Page.navigate', { url }).catch(() => {});
          return;
        }
        try {
          await esperar(esperaMs || 2500); // deixa o JS da loja montar a lista

          /* Interacao opcional: digitar de verdade num campo (CEP, por exemplo).
             Eventos sinteticos de teclado sao ignorados por varias lojas; aqui
             o texto entra pelo proprio Chrome, como se a pessoa tivesse digitado. */
          if (interacao) {
            const foco = await enviar('Runtime.evaluate', {
              expression: interacao.preparar,
              returnByValue: true,
              awaitPromise: true,
            });
            const achou = foco && foco.result && foco.result.value;
            if (achou) {
              /* Digita caractere por caractere, como uma pessoa: varias lojas so
                 calculam o frete quando recebem os eventos de tecla de verdade. */
              for (const ch of String(interacao.texto || '')) {
                await enviar('Input.dispatchKeyEvent', {
                  type: 'keyDown', text: ch, unmodifiedText: ch, key: ch,
                  windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
                });
                await enviar('Input.dispatchKeyEvent', {
                  type: 'keyUp', key: ch,
                  windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
                });
                await esperar(60);
              }
              await esperar(600);
              if (interacao.enter) {
                for (const tipo of ['keyDown', 'keyUp']) {
                  await enviar('Input.dispatchKeyEvent', {
                    type: tipo, key: 'Enter', code: 'Enter',
                    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
                  });
                }
              }
              await esperar(interacao.esperaDepoisMs || 1500);

              /* Clique real (mouse do proprio Chrome): varias lojas ignoram
                 element.click() feito por JavaScript, mas obedecem este. */
              if (interacao.clicar) {
                const pos = await enviar('Runtime.evaluate', {
                  expression: interacao.clicar,
                  returnByValue: true,
                  awaitPromise: true,
                });
                const p = pos && pos.result && pos.result.value;
                if (p && typeof p.x === 'number') {
                  for (const tipo of ['mousePressed', 'mouseReleased']) {
                    await enviar('Input.dispatchMouseEvent', {
                      type: tipo, x: Math.round(p.x), y: Math.round(p.y),
                      button: 'left', clickCount: 1,
                    });
                  }
                  await esperar(1200);
                }
              }

              if (interacao.depois) {
                await enviar('Runtime.evaluate', { expression: interacao.depois, returnByValue: true, awaitPromise: true });
              }
            }
          }

          const r = await enviar('Runtime.evaluate', {
            expression: script,
            returnByValue: true,
            awaitPromise: true,
          });
          terminou = true;
          clearTimeout(limite);
          try { socket.close(); } catch {}
          if (r && r.exceptionDetails) reject(new Error('Script falhou na pagina.'));
          else resolve(r && r.result ? r.result.value : null);
        } catch (e) {
          terminou = true;
          clearTimeout(limite);
          try { socket.close(); } catch {}
          reject(e);
        }
      }
    });

    socket.addEventListener('error', () => {
      if (!terminou) { terminou = true; clearTimeout(limite); reject(new Error('Falha na conexao com o navegador.')); }
    });

    socket.addEventListener('open', async () => {
      try {
        await enviar('Page.enable');
        await enviar('Emulation.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          acceptLanguage: 'pt-BR,pt;q=0.9',
        });
        await enviar('Page.navigate', { url: visitaPendente ? visitarAntes : url });
      } catch (e) {
        if (!terminou) { terminou = true; clearTimeout(limite); reject(e); }
      }
    });
  });
}

/* API publica: abre a url e devolve o que o script coletar. */
async function extrair(url, script, opcoes) {
  const o = opcoes || {};
  const { endereco } = await abrirNavegador();

  // cria uma aba nova
  const r = await fetch(endereco + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })
    .catch(() => fetch(endereco + '/json/new?' + encodeURIComponent('about:blank')));
  const aba = await r.json();
  if (!aba || !aba.webSocketDebuggerUrl) throw new Error('Nao consegui abrir uma aba no navegador.');

  try {
    return await comAba(aba.webSocketDebuggerUrl, url, script, o.esperaMs, o.visitarAntes, o.interacao);
  } finally {
    fetch(endereco + '/json/close/' + aba.id).catch(() => {});
  }
}

module.exports = { disponivel, extrair, fechar, caminhoChrome: () => CHROME };
```

## coletores/kabum.js

KaBuM! — API publica do catalogo

```js
'use strict';
/* Coletor da KaBuM! usando a API publica do catalogo (a mesma que o site consome).
   Nao exige credenciais. */

const NOME = 'KaBuM!';
const BASE = 'https://servicespub.prod.api.aws.grupokabum.com.br/catalog/v2/products';
const LIMITE = Number(process.env.KABUM_LIMITE) || 12;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// A API é aberta: nada para configurar.
function configurado() {
  return true;
}

function normalizar(item) {
  const a = item.attributes || {};
  // price_with_discount é o preço à vista (boleto/pix); price é o "de".
  const preco = Number(a.price_with_discount) > 0 ? Number(a.price_with_discount) : Number(a.price) || 0;
  // product_link e apenas o "slug" do produto: a URL valida e /produto/{id}/{slug}
  const slug = String(a.product_link || '').replace(/^\//, '');
  const url = 'https://www.kabum.com.br/produto/' + item.id + (slug ? '/' + slug : '');

  return {
    loja: NOME,
    titulo: String(a.title || ''),
    preco,
    // A KaBuM! só calcula o frete no carrinho, com CEP. Registramos 0 e deixamos
    // o ajuste manual a cargo de quem compara.
    frete: 0,
    preco_total: preco,
    frete_gratis: Boolean(a.has_free_shipping),
    condicao: a.is_openbox ? 'usado' : 'novo',
    vendedor: a.is_marketplace && a.marketplace ? String(a.marketplace.name || 'marketplace') : NOME,
    reputacao: a.is_marketplace ? '' : '5_green', // venda direta da loja: risco baixo
    vendidos: 0,
    parcelas: Number(a.max_installment) || 0,
    url,
    id_externo: String(item.id || ''),
  };
}

async function buscar(termo) {
  const url = BASE + '?query=' + encodeURIComponent(termo) + '&limit=' + LIMITE;
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Origin: 'https://www.kabum.com.br',
      Referer: 'https://www.kabum.com.br/busca/' + encodeURIComponent(termo),
      'sec-ch-ua': '\"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '\"Windows\"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    },
  });

  // A KaBuM! responde 404 quando a busca nao encontra nada: isso e resultado vazio, nao falha.
  if (r.status === 404) return [];

  if (r.status === 403) {
    throw new Error(
      'A KaBuM! recusou a consulta (403). A API funciona a partir de uma rede brasileira, mas ' +
      'costuma bloquear servidores de nuvem no exterior. Rode o coletor local (npm run coletar) ' +
      'ou lance a oferta manualmente.'
    );
  }
  if (!r.ok) throw new Error('KaBuM! respondeu HTTP ' + r.status + '.');

  const dados = await r.json().catch(() => ({}));
  const itens = Array.isArray(dados.data) ? dados.data : [];
  return itens
    .filter((i) => i.attributes && i.attributes.available)
    .map(normalizar)
    .filter((o) => o.preco > 0);
}

module.exports = { nome: NOME, chave: 'kabum', configurado, buscar };
```

## coletores/pichau.js

Pichau — navegador local

```js
'use strict';
/* Coletor da Pichau. A loja recusa requisicoes simples (403), entao a pagina de
   busca e aberta no navegador local (coletores/navegador.js). */

const navegador = require('./navegador.js');

const NOME = 'Pichau';
const LIMITE = Number(process.env.PICHAU_LIMITE) || 12;

const configurado = () => navegador.disponivel();

/* Script executado dentro da pagina da loja. */
const SCRIPT = `(() => {
  const textoDe = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const acharPorClasse = (raiz, parte) =>
    [...raiz.querySelectorAll('*')].find((e) => String(e.className || '').indexOf(parte) !== -1);

  const cartoes = [...document.querySelectorAll('a')]
    .filter((a) => a.querySelector('img') && /R\\$/.test(a.textContent) && a.getAttribute('href'));

  const vistos = new Set();
  const itens = [];

  for (const a of cartoes) {
    const href = a.getAttribute('href');
    if (!href || vistos.has(href)) continue;
    vistos.add(href);

    const titulo = textoDe(a.querySelector('.MuiTypography-h6')) ||
                   textoDe(a.querySelector('h2')) ||
                   textoDe(a.querySelector('img') && a.querySelector('img').getAttribute ? null : null);

    const vista = textoDe(acharPorClasse(a, 'price_vista'));
    const total = textoDe(acharPorClasse(a, 'price_total'));
    const precoTexto = vista || total;
    if (!precoTexto) continue;

    itens.push({
      titulo,
      precoTexto,
      href: href.indexOf('http') === 0 ? href : 'https://www.pichau.com.br' + href,
      esgotado: /indispon|esgotad/i.test(a.textContent),
    });
  }
  return itens;
})()`;

function paraNumero(texto) {
  const limpo = String(texto || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

async function buscar(termo) {
  const url = 'https://www.pichau.com.br/search?q=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 4000 })) || [];

  return itens
    .filter((i) => !i.esgotado)
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        frete: 0, // a Pichau so calcula o frete com o CEP, no carrinho
        preco_total: preco,
        frete_gratis: false,
        // a Pichau marca no titulo os produtos de mostruario
        condicao: /openbox/i.test(i.titulo) ? 'usado' : 'novo',
        vendedor: NOME,
        reputacao: '5_green', // venda direta da loja
        vendidos: 0,
        parcelas: 0,
        url: i.href,
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'pichau', configurado, buscar };
```

## coletores/terabyte.js

Terabyte — navegador local

```js
'use strict';
/* Coletor da Terabyte Shop, pelo navegador local (a loja recusa requisicoes simples). */

const navegador = require('./navegador.js');

const NOME = 'Terabyte';
const LIMITE = Number(process.env.TERABYTE_LIMITE) || 12;

const configurado = () => navegador.disponivel();

const SCRIPT = `(() => {
  const cartoes = [...document.querySelectorAll('.product-item__box, .commerce_columns_item')];
  const itens = [];

  for (const c of cartoes) {
    const a = c.querySelector('a[href*="/produto/"]');
    if (!a) continue;

    const texto = c.textContent.replace(/\\s+/g, ' ').trim();
    const titulo = (c.querySelector('.product-item__name, h2, .prod-name') || {}).textContent
      || texto.split(/De:|R\\$/)[0];

    // "De: R$ 305,87 por: R$ 259,99 a vista" -> queremos o "por"
    const porMatch = texto.match(/por:?\\s*R\\$\\s*([\\d.,]+)/i);
    const todos = texto.match(/R\\$\\s*[\\d.,]+/g) || [];
    const precoTexto = porMatch ? porMatch[1] : (todos.length > 1 ? todos[1] : (todos[0] || ''));

    const href = a.getAttribute('href');
    itens.push({
      titulo: String(titulo).trim(),
      precoTexto,
      href: href.indexOf('http') === 0 ? href : 'https://www.terabyteshop.com.br' + href,
      esgotado: /indispon|avise-me|esgotad/i.test(texto),
    });
  }
  return itens;
})()`;

function paraNumero(texto) {
  const limpo = String(texto || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

async function buscar(termo) {
  const url = 'https://www.terabyteshop.com.br/busca?str=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 3500 })) || [];

  return itens
    .filter((i) => !i.esgotado)
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        frete: 0,
        preco_total: preco,
        frete_gratis: false,
        condicao: 'novo',
        vendedor: NOME,
        reputacao: '5_green',
        vendidos: 0,
        parcelas: 0,
        url: i.href,
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'terabyte', configurado, buscar };
```

## coletores/patoloco.js

Patoloco — navegador local

```js
'use strict';
/* Coletor da Patoloco, pelo navegador local. */

const navegador = require('./navegador.js');

const NOME = 'Patoloco';
const LIMITE = Number(process.env.PATOLOCO_LIMITE) || 12;

const configurado = () => navegador.disponivel();

const SCRIPT = `(() => {
  const itens = [];
  const caixas = [...document.querySelectorAll('.wapper-product-price')];

  for (const caixa of caixas) {
    // sobe ate o cartao do produto (o que tem link e titulo)
    let cartao = caixa;
    for (let i = 0; i < 6 && cartao; i++) {
      cartao = cartao.parentElement;
      if (cartao && cartao.querySelector('a[href]') && cartao.textContent.length > 80) break;
    }
    if (!cartao) continue;

    const a = cartao.querySelector('a[href]');
    if (!a) continue;

    const titulos = [...cartao.querySelectorAll('h1,h2,h3,h4,a,span')]
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim())
      // descarta textos de promocao e contador, que ficam no mesmo cartao
      .filter((t) => t.length > 20 && t.length < 200 && !/R\\$/.test(t)
        && !/promo|acaba em|desconto|comprar|frete|parcel|avise|estoque|cupom|adicionar/i.test(t));
    const titulo = titulos.sort((x, y) => x.length - y.length)[0] || '';

    const textoPreco = caixa.textContent.replace(/\\s+/g, ' ').trim();
    // "10% DE DESCONTO R$ 109,57 R$ 83,82 a vista no PIX" -> queremos o segundo
    const valores = textoPreco.match(/R\\$\\s*[\\d.,]+/g) || [];
    const precoTexto = valores.length > 1 ? valores[1] : (valores[0] || '');

    const textoCartao = cartao.textContent;
    itens.push({
      titulo,
      precoTexto,
      href: a.getAttribute('href'),
      esgotado: /indispon|avise-me|esgotad/i.test(textoCartao),
      openbox: /open-?box/i.test(textoCartao),
    });
  }
  return itens;
})()`;

function paraNumero(texto) {
  const limpo = String(texto || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

async function buscar(termo) {
  const url = 'https://patoloco.com.br/busca?buscar-por=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 4000 })) || [];

  const vistos = new Set();
  return itens
    .filter((i) => !i.esgotado)
    .filter((i) => {
      if (vistos.has(i.href)) return false;
      vistos.add(i.href);
      return true;
    })
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      const href = String(i.href || '');
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        frete: 0,
        preco_total: preco,
        frete_gratis: false,
        condicao: i.openbox ? 'usado' : 'novo',
        vendedor: NOME,
        reputacao: '5_green',
        vendidos: 0,
        parcelas: 0,
        url: href.indexOf('http') === 0 ? href : 'https://patoloco.com.br/' + href.replace(/^\//, ''),
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'patoloco', configurado, buscar };
```

## coletores/setupninja.js

Setup Ninja — navegador local

```js
'use strict';
/* Coletor da Setup Ninja, pelo navegador local. */

const navegador = require('./navegador.js');

const NOME = 'Setup Ninja';
const LIMITE = Number(process.env.SETUPNINJA_LIMITE) || 12;

const configurado = () => navegador.disponivel();

const SCRIPT = `(() => {
  const itens = [];
  const cartoes = [...document.querySelectorAll('.product-card')];

  for (const c of cartoes) {
    const a = c.querySelector('a[href]');
    if (!a) continue;

    const texto = c.textContent.replace(/\\s+/g, ' ').trim();

    // titulo: maior trecho sem preco nem porcentagem
    const titulo = [...c.querySelectorAll('h1,h2,h3,h4,p,span,div')]
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim())
      .filter((t) => t.length > 18 && t.length < 200 && !/R\\$|% OFF/.test(t))
      .sort((x, y) => x.length - y.length)[0] || '';

    // "price total" e o valor no pix (o que a loja destaca)
    const alvo = c.querySelector('.price.total') || c.querySelector('[class*="price"]');
    const precoTexto = alvo ? alvo.textContent.trim() : (texto.match(/R\\$\\s*[\\d.,]+/) || [''])[0];

    itens.push({
      titulo,
      precoTexto,
      href: a.getAttribute('href'),
      esgotado: /indispon|esgotad|avise-me/i.test(texto),
    });
  }
  return itens;
})()`;

function paraNumero(texto) {
  const limpo = String(texto || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

async function buscar(termo) {
  const url = 'https://www.setupninja.com.br/produtos?q=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 5000 })) || [];

  const vistos = new Set();
  return itens
    .filter((i) => !i.esgotado)
    .filter((i) => {
      if (vistos.has(i.href)) return false;
      vistos.add(i.href);
      return true;
    })
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      const href = String(i.href || '');
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        frete: 0,
        preco_total: preco,
        frete_gratis: false,
        condicao: 'novo',
        vendedor: NOME,
        reputacao: '5_green',
        vendidos: 0,
        parcelas: 0,
        url: href.indexOf('http') === 0 ? href : 'https://www.setupninja.com.br/' + href.replace(/^\//, ''),
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'setupninja', configurado, buscar };
```

## coletores/amazon.js

Amazon BR — navegador local

```js
'use strict';
/* Coletor da Amazon BR, pelo navegador local.
   A Amazon recusa requisicoes simples (503) mas responde normalmente a um navegador. */

const navegador = require('./navegador.js');

const NOME = 'Amazon';
const LIMITE = Number(process.env.AMAZON_LIMITE) || 12;

const configurado = () => navegador.disponivel();

const SCRIPT = `(() => {
  const itens = [];
  const cartoes = [...document.querySelectorAll('div[data-asin]')].filter((c) => c.getAttribute('data-asin'));

  for (const c of cartoes) {
    const asin = c.getAttribute('data-asin');
    if (!asin) continue;

    const tituloEl = c.querySelector('h2');
    const titulo = tituloEl ? tituloEl.textContent.replace(/\\s+/g, ' ').trim() : '';
    if (!titulo) continue;

    const precoEl = c.querySelector('.a-price .a-offscreen');
    if (!precoEl) continue;

    const texto = c.textContent;
    itens.push({
      asin,
      titulo,
      precoTexto: precoEl.textContent.trim(),
      patrocinado: /patrocinado|sponsored/i.test(texto),
      usado: /usado|recondicionado|renewed/i.test(texto),
    });
  }
  return itens;
})()`;

function paraNumero(texto) {
  const limpo = String(texto || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

async function buscar(termo) {
  const url = 'https://www.amazon.com.br/s?k=' + encodeURIComponent(termo);
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 4000 })) || [];

  const vistos = new Set();
  return itens
    .filter((i) => {
      if (vistos.has(i.asin)) return false;
      vistos.add(i.asin);
      return true;
    })
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        frete: 0, // o frete depende do CEP e do Prime
        preco_total: preco,
        frete_gratis: false,
        condicao: i.usado ? 'usado' : 'novo',
        // a Amazon tambem vende por terceiros; sem essa informacao na busca,
        // fica como reputacao neutra em vez de maxima
        vendedor: NOME,
        reputacao: '4_light_green',
        vendidos: 0,
        parcelas: 0,
        url: 'https://www.amazon.com.br/dp/' + i.asin,
        id_externo: i.asin,
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'amazon', configurado, buscar };
```

## coletores/magalu.js

Magazine Luiza — implementado, desligado (a loja bloqueia automacao)

```js
'use strict';
/* Coletor do Magazine Luiza, pelo navegador local.
   Muitos anuncios sao de vendedores parceiros (marketplace): guardamos quem vende. */

const navegador = require('./navegador.js');

const NOME = 'Magazine Luiza';
const LIMITE = Number(process.env.MAGALU_LIMITE) || 12;

// A Magalu bloqueia acesso automatizado mesmo com navegador real ("Nao e possivel
// acessar a pagina"). Fica desligada ate existir um caminho legitimo; ative com
// MAGALU_ATIVO=1 para testar.
const configurado = () => process.env.MAGALU_ATIVO === '1' && navegador.disponivel();

const SCRIPT = `(() => {
  const links = [...document.querySelectorAll('a[href*="/p/"]')];
  const vistos = new Set();
  const itens = [];

  for (const a of links) {
    const href = a.getAttribute('href');
    if (!href || vistos.has(href)) continue;
    vistos.add(href);

    const texto = a.textContent.replace(/\\s+/g, ' ').trim();
    if (!/R\\$/.test(texto)) continue;

    // titulo: o trecho antes da nota/preco
    const titulo = (a.querySelector('h2, [data-testid="product-title"]') || {}).textContent
      || texto.split(/\\d,\\d\\(|Preço|R\\$/)[0];

    const precoMatch = texto.match(/R\\$\\s*([\\d.,]+)/);
    const vendedor = (href.match(/seller_id=([^&]+)/) || [])[1] || '';

    itens.push({
      titulo: String(titulo).replace(/^Full/, '').trim(),
      precoTexto: precoMatch ? precoMatch[1] : '',
      href: href.indexOf('http') === 0 ? href : 'https://www.magazineluiza.com.br' + href,
      vendedor,
      esgotado: /indispon|esgotad/i.test(texto),
    });
  }
  return itens;
})()`;

function paraNumero(texto) {
  const limpo = String(texto || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

async function buscar(termo) {
  const url = 'https://www.magazineluiza.com.br/busca/' + encodeURIComponent(termo) + '/';
  const itens = (await navegador.extrair(url, SCRIPT, { esperaMs: 4500, visitarAntes: 'https://www.magazineluiza.com.br/' })) || [];

  return itens
    .filter((i) => !i.esgotado)
    .slice(0, LIMITE)
    .map((i) => {
      const preco = paraNumero(i.precoTexto);
      const proprio = !i.vendedor || i.vendedor === 'magazineluiza';
      return {
        loja: NOME,
        titulo: String(i.titulo || '').slice(0, 200),
        preco,
        frete: 0,
        preco_total: preco,
        frete_gratis: false,
        condicao: 'novo',
        vendedor: proprio ? NOME : i.vendedor,
        // vendedor parceiro nao tem a mesma garantia da loja: entra com reputacao neutra
        reputacao: proprio ? '5_green' : '3_yellow',
        vendidos: 0,
        parcelas: 0,
        url: i.href,
        id_externo: '',
      };
    })
    .filter((o) => o.preco > 0 && o.titulo);
}

module.exports = { nome: NOME, chave: 'magalu', configurado, buscar };
```

## coletores/mercadolivre.js

Mercado Livre — API oficial, bloqueada para apps nao liberados

```js
'use strict';
/* Coletor do Mercado Livre usando a API oficial.
   Precisa de um aplicativo criado em https://developers.mercadolivre.com.br
   e das variaveis de ambiente ML_CLIENT_ID e ML_CLIENT_SECRET. */

const SITE = process.env.ML_SITE || 'MLB'; // MLB = Brasil
const CLIENT_ID = String(process.env.ML_CLIENT_ID || '').trim().replace(/^["']|["']$/g, '');
const CLIENT_SECRET = String(process.env.ML_CLIENT_SECRET || '').trim().replace(/^["']|["']$/g, '');
const LIMITE = Number(process.env.ML_LIMITE) || 20;

const NOME = 'Mercado Livre';

let cache = { token: '', expira: 0 };

function configurado() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function obterToken() {
  if (cache.token && Date.now() < cache.expira) return cache.token;

  const corpo = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: corpo,
  });
  const dados = await r.json().catch(() => ({}));

  if (!r.ok || !dados.access_token) {
    const detalhe = dados.message || dados.error || ('HTTP ' + r.status);
    throw new Error(
      'Nao foi possivel autenticar no Mercado Livre: ' + detalhe +
      ' (Client ID usado: ' + CLIENT_ID.slice(0, 6) + '...' + CLIENT_ID.slice(-4) + ', tamanho do secret: ' + CLIENT_SECRET.length + ' caracteres)'
    );
  }

  cache = {
    token: dados.access_token,
    // renova um minuto antes de expirar
    expira: Date.now() + (Number(dados.expires_in) || 21600) * 1000 - 60000,
  };
  return cache.token;
}

const CONDICAO = { new: 'novo', used: 'usado', not_specified: 'nao informado' };

function normalizar(item) {
  const preco = Number(item.price) || 0;
  const freteGratis = Boolean(item.shipping && item.shipping.free_shipping);
  // A API de busca nao devolve o frete exato (depende do CEP do comprador).
  // Guardamos 0 quando o frete e gratis e deixamos o ajuste manual para os demais.
  const frete = freteGratis ? 0 : 0;

  return {
    loja: NOME,
    titulo: String(item.title || ''),
    preco,
    frete,
    preco_total: preco + frete,
    frete_gratis: freteGratis,
    condicao: CONDICAO[item.condition] || 'nao informado',
    vendedor: String(
      (item.seller && (item.seller.nickname || item.seller.eshop && item.seller.eshop.nick_name)) ||
      (item.official_store_name || '')
    ),
    reputacao: String(
      (item.seller && item.seller.seller_reputation && item.seller.seller_reputation.level_id) || ''
    ),
    vendidos: Number(item.sold_quantity) || 0,
    parcelas: Number(item.installments && item.installments.quantity) || 0,
    url: String(item.permalink || ''),
    id_externo: String(item.id || ''),
  };
}

async function buscar(termo) {
  if (!configurado()) {
    throw new Error(
      'Mercado Livre nao configurado: defina ML_CLIENT_ID e ML_CLIENT_SECRET nas variaveis de ambiente.'
    );
  }
  const token = await obterToken();
  const url =
    'https://api.mercadolibre.com/sites/' + SITE + '/search?q=' + encodeURIComponent(termo) +
    '&limit=' + LIMITE;

  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });

  if (r.status === 403) {
    // Desde 2025 o Mercado Livre restringiu /sites/$SITE/search: aplicacoes comuns
    // recebem 403 mesmo com token valido e permissao de leitura. E preciso pedir
    // liberacao do endpoint ao suporte / Developer Partner Program.
    throw new Error(
      'O Mercado Livre bloqueia a busca publica para aplicacoes nao liberadas (403). ' +
      'Suas credenciais estao corretas: o token foi emitido. Para usar esta fonte e preciso ' +
      'solicitar a liberacao do endpoint de busca ao suporte do Mercado Livre. ' +
      'Enquanto isso, use as outras lojas ou o lancamento manual de ofertas.'
    );
  }
  if (r.status === 401) {
    cache = { token: '', expira: 0 };
    throw new Error('Mercado Livre recusou o token (401). Verifique ML_CLIENT_ID e ML_CLIENT_SECRET.');
  }
  if (!r.ok) throw new Error('Mercado Livre respondeu HTTP ' + r.status + '.');

  const dados = await r.json().catch(() => ({}));
  const itens = Array.isArray(dados.results) ? dados.results : [];
  return itens.map(normalizar).filter((o) => o.preco > 0);
}

module.exports = { nome: NOME, chave: 'mercadolivre', configurado, buscar };
```

## coletores/frete.js

Frete e prazo por CEP — infraestrutura pronta, em aberto

```js
'use strict';
/* Calculo de frete e prazo por CEP.
   -------------------------------------------------------------------------
   As lojas so revelam frete e prazo depois que o comprador informa o CEP, na
   pagina do produto. Este modulo abre a pagina da oferta no navegador local,
   preenche o CEP e le o resultado.

   E caro (uma pagina por oferta), entao o agente so calcula o frete das
   melhores ofertas de cada loja, que sao as que disputam a recomendacao. */

const navegador = require('./navegador.js');

const disponivel = () => navegador.disponivel();

/* Passo 1: abre a caixa de CEP e coloca o cursor no campo.
   Quem digita e o proprio Chrome (Input.insertText), nao o JavaScript. */
function scriptPreparar(seletorCampo) {
  return `(async () => {
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const visivel = (e) => e && e.offsetParent !== null;

    const abridor = [...document.querySelectorAll('button, a')].find((b) =>
      visivel(b) && /cep|calcular frete/i.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent));
    if (abridor) { abridor.click(); await espera(1200); }

    const campo = ${seletorCampo ? `document.querySelector(${JSON.stringify(seletorCampo)}) || ` : ''}
      [...document.querySelectorAll('input')].filter(visivel).find((i) => /cep|zip|postal/i.test(
        (i.getAttribute('placeholder') || '') + (i.id || '') + (i.getAttribute('name') || '') +
        (i.getAttribute('aria-label') || '') + (i.className || '')));
    if (!campo) return false;

    campo.focus();
    campo.select && campo.select();
    return true;
  })()`;
}

/* Passo 2: devolve a posicao do botao de confirmar, para um clique real do mouse. */
const SCRIPT_POSICAO_BOTAO = `(() => {
  const visivel = (e) => e && e.offsetParent !== null;
  const rotulo = (b) => ((b.getAttribute('aria-label') || '') + ' ' + b.textContent).replace(/\s+/g, ' ').trim();
  const abridor = [...document.querySelectorAll('button')].find((b) => /abrir caixa/i.test(rotulo(b)));
  const botao = [...document.querySelectorAll('button')]
    .filter((b) => visivel(b) && b !== abridor)
    .find((b) => /inserir\s*cep|calcular frete|^calcular$/i.test(rotulo(b)));
  if (!botao) return null;
  const r = botao.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/* Passo 3 (reserva): clique por JavaScript, quando o clique real nao se aplica. */
const SCRIPT_CONFIRMAR = `(() => {
  const visivel = (e) => e && e.offsetParent !== null;
  const rotulo = (b) => ((b.getAttribute('aria-label') || '') + ' ' + b.textContent).replace(/\\s+/g, ' ').trim();
  const botao = [...document.querySelectorAll('button')].filter(visivel)
    .find((b) => /inserir\\s*cep|calcular frete|calcular$/i.test(rotulo(b)));
  if (botao) botao.click();
  return true;
})()`;

/* Passo 3: le o bloco que mostra frete e prazo. */
const SCRIPT_LER = `(async () => {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const fora = (e) => !e.closest('header, nav, footer');
  const padrao = /(chegar[\u00e1a]|receba|entrega em|dias\\s*[\u00fau]teis|prazo de entrega|frete)/i;

  const procurar = () => {
    const candidatos = [...document.querySelectorAll('div, section, li, p, span, td')]
      .filter((e) => e.offsetParent !== null && fora(e))
      .filter((e) => {
        const t = e.textContent || '';
        return t.length < 300 && padrao.test(t) && /(R\\$\\s*[\\d.,]+|gr[\u00e1a]tis)/i.test(t);
      });
    candidatos.sort((a, b) => a.textContent.length - b.textContent.length);
    return candidatos[0] || null;
  };

  let bloco = null;
  for (let i = 0; i < 12 && !bloco; i++) {
    await espera(1000);
    bloco = procurar();
  }
  if (!bloco) return { erro: 'sem informacao de entrega' };
  return { trecho: bloco.textContent.replace(/\\s+/g, ' ').trim() };
})()`;

const SELETORES = {
  'KaBuM!': '#zipCodeInputField',
};

function valorDoTexto(trecho) {
  // "Chegara ate segunda-feira, 28/09 R$ 11,66" / "Frete gratis"
  if (/gr[aá]tis|gratuito/i.test(trecho)) return 0;
  const m = trecho.match(/R\$\s*([\d.]+,\d{2})/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function prazoDoTexto(trecho) {
  const ate = trecho.match(/(chegar[áa]\s+at[ée]|receba\s+at[ée]|entrega\s+at[ée])\s+([^R$|.]{3,40})/i);
  if (ate) return ate[0].replace(/\s+/g, ' ').trim().slice(0, 60);
  const dias = trecho.match(/(\d+)\s*(a\s*\d+\s*)?dias?\s*[úu]teis/i);
  if (dias) return dias[0].trim();
  return '';
}

/* Consulta o frete de UMA oferta. Devolve { frete, prazo } ou null. */
async function consultar(oferta, cep) {
  if (!disponivel() || !oferta.url) return null;
  try {
    const r = await navegador.extrair(oferta.url, SCRIPT_LER, {
      esperaMs: 2500,
      interacao: {
        preparar: scriptPreparar(SELETORES[oferta.loja]),
        texto: cep,
        enter: true,
        clicar: SCRIPT_POSICAO_BOTAO,
        depois: SCRIPT_CONFIRMAR,
        esperaDepoisMs: 1200,
      },
    });
    if (!r || r.erro || !r.trecho) return null;

    const frete = valorDoTexto(r.trecho);
    const prazo = prazoDoTexto(r.trecho);
    if (frete === null && !prazo) return null;
    return { frete: frete === null ? 0 : frete, prazo, frete_estimado: frete === null };
  } catch (e) {
    return null;
  }
}

/* Calcula o frete das melhores ofertas (uma por loja) em paralelo. */
async function calcularParaMelhores(ofertas, cep, limite) {
  if (!cep || !/^\d{8}$/.test(String(cep).replace(/\D/g, ''))) return ofertas;
  const cepLimpo = String(cep).replace(/\D/g, '');

  // melhor oferta de cada loja, as mais baratas primeiro
  const porLoja = new Map();
  ofertas.forEach((o) => {
    const atual = porLoja.get(o.loja);
    if (!atual || o.preco < atual.preco) porLoja.set(o.loja, o);
  });
  const alvos = [...porLoja.values()].sort((a, b) => a.preco - b.preco).slice(0, limite || 4);

  const resultados = await Promise.all(alvos.map(async (o) => ({ oferta: o, dados: await consultar(o, cepLimpo) })));

  resultados.forEach(({ oferta, dados }) => {
    if (!dados) return;
    oferta.frete = dados.frete;
    oferta.preco_total = oferta.preco + dados.frete;
    oferta.prazo = dados.prazo;
    oferta.frete_calculado = true;
  });

  return ofertas;
}

module.exports = { disponivel, consultar, calcularParaMelhores, valorDoTexto, prazoDoTexto };
```

---

# Interface

## public/index.html

Estrutura das telas: busca, resultado, detalhe, metricas e administracao

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comparador de Preços Gamer</title>
<link rel="stylesheet" href="/estilo.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎮</text></svg>">
</head>
<body class="capa">

<header class="topo">
  <div class="marca-empresa">
    <span class="marca-sigla">CHIPS</span>
    <span class="marca-tipo">company</span>
  </div>
  <nav id="menu" class="menu"></nav>
  <div class="topo-dir">
    <span id="ola" class="ola"></span>
    <button id="btn-sair" class="botao fantasma oculto">Sair</button>
  </div>
</header>

<!-- ---------- BUSCA PÚBLICA ---------- -->
<canvas id="fundo-gamer" aria-hidden="true"></canvas>

<main id="vista-busca" class="conteudo centralizada">
  <section class="heroi">
    <h1>Onde está mais barato?</h1>
    <p class="sub">Digite o equipamento que você quer e o sistema procura nas lojas, compara o preço final e mostra onde compensa comprar.</p>

    <form id="form-busca" class="caixa-busca">
      <input id="campo-busca" name="termo" placeholder="teclado mecânico redragon, rtx 4060, headset hyperx..." autocomplete="off" required>
      <button class="botao primario" type="submit">Buscar</button>
    </form>

    <p id="frase" class="frase"></p>

    <div id="sugestoes" class="sugestoes"></div>
  </section>

  <section id="estado-busca" class="painel oculto"></section>

  <section id="resultado" class="oculto">
    <div id="res-veredito"></div>

    <div class="painel">
      <h2>Todas as ofertas encontradas</h2>
      <table class="tabela">
        <thead>
          <tr>
            <th>Loja</th><th>Anúncio</th><th>Condição</th><th>Vendedor</th>
            <th class="dir">Preço</th><th class="dir">Frete</th><th class="dir">Total</th><th></th>
          </tr>
        </thead>
        <tbody id="tbody-ofertas"></tbody>
      </table>
      <p id="vazio-ofertas" class="vazio oculto">Nenhuma oferta encontrada para esse termo.</p>
      <div id="paginacao" class="paginacao oculto"></div>
    </div>
  </section>

  <section id="monitorados" class="painel oculto">
    <h2>Produtos acompanhados</h2>
    <p class="sub">Estes têm histórico de preço: dá para ver se o valor de hoje está bom.</p>
    <table class="tabela">
      <thead>
        <tr>
          <th>Produto</th><th>Categoria</th><th>Melhor loja</th>
          <th class="dir">Menor preço</th><th class="dir">Ofertas</th><th>Atualizado</th><th></th>
        </tr>
      </thead>
      <tbody id="tbody-produtos"></tbody>
    </table>
  </section>

  <div class="grade so-admin oculto">
    <section class="painel">
      <h2>Adicionar produto ao acompanhamento</h2>
      <form id="form-produto" class="form compacto">
        <label>Nome do produto<input name="nome" placeholder="Teclado Redragon Kumara K552" required></label>
        <label>Termo de busca<input name="termo" placeholder="redragon kumara k552"></label>
        <div class="linha">
          <label>Categoria
            <select name="categoria">
              <option>Teclado</option><option>Mouse</option><option>Headset</option>
              <option>Monitor</option><option>Placa de vídeo</option><option>Processador</option>
              <option>Memória RAM</option><option>Cadeira gamer</option><option>Console</option>
              <option>Jogo</option><option>Outros</option>
            </select>
          </label>
          <label>Preço-alvo<input name="preco_alvo" inputmode="decimal" placeholder="0,00"></label>
        </div>
        <button class="botao primario" type="submit">Monitorar preço</button>
      </form>
    </section>

    <section class="painel">
      <h2>Coleta</h2>
      <p class="dica">Atualiza os preços de todos os produtos acompanhados.</p>
      <button id="btn-coletar-todos" class="botao">Atualizar preços de todos</button>
      <div id="aviso-coleta" class="aviso-fontes oculto"></div>
    </section>
  </div>
</main>

<!-- ---------- DETALHE DE UM PRODUTO ACOMPANHADO ---------- -->
<main id="vista-detalhe" class="conteudo oculto">
  <div class="cabecalho-tela">
    <div>
      <h1 id="det-nome"></h1>
      <p id="det-sub" class="sub"></p>
    </div>
    <div class="barra-acoes">
      <button id="det-voltar" class="botao fantasma">← Voltar</button>
      <button id="det-coletar" class="botao primario so-admin oculto">Atualizar preços agora</button>
    </div>
  </div>

  <div id="det-veredito"></div>

  <div class="grade">
    <section class="painel">
      <h2>Onde compensa comprar</h2>
      <div id="det-ranking"></div>
    </section>
    <section class="painel">
      <h2>Histórico de preços</h2>
      <div id="det-grafico"></div>
    </section>
  </div>

  <section class="painel">
    <h2>Todas as ofertas da última coleta</h2>
    <table class="tabela">
      <thead>
        <tr>
          <th>Loja</th><th>Anúncio</th><th>Condição</th><th>Vendedor</th>
          <th class="dir">Preço</th><th class="dir">Frete</th><th class="dir">Total</th><th></th>
        </tr>
      </thead>
      <tbody id="tbody-det-ofertas"></tbody>
    </table>
    <p id="vazio-det-ofertas" class="vazio">Nenhuma oferta coletada ainda.</p>
  </section>
</main>

<!-- ---------- MÉTRICAS (público: dados do TCC) ---------- -->
<main id="vista-metricas" class="conteudo oculto">
  <div class="cabecalho-tela">
    <div>
      <h1>Métricas do sistema</h1>
      <p class="sub">Dados de operação dos coletores — base para o capítulo de resultados do TCC.</p>
    </div>
    <button id="met-atualizar" class="botao">Atualizar</button>
  </div>

  <section class="kpis">
    <article class="kpi"><h3>Buscas realizadas</h3><strong id="met-buscas">0</strong><span id="met-buscas-sub" class="variacao neutro"></span></article>
    <article class="kpi"><h3>Tempo médio por busca</h3><strong id="met-tempo">—</strong><span id="met-tempo-sub" class="variacao neutro"></span></article>
    <article class="kpi"><h3>Ofertas coletadas</h3><strong id="met-ofertas">0</strong><span id="met-ofertas-sub" class="variacao neutro"></span></article>
    <article class="kpi"><h3>Histórico acumulado</h3><strong id="met-historico">0</strong><span id="met-historico-sub" class="variacao neutro"></span></article>
  </section>

  <section class="painel">
    <h2>Desempenho por loja</h2>
    <table class="tabela">
      <thead>
        <tr>
          <th>Loja</th><th class="dir">Consultas</th><th class="dir">Sucesso</th>
          <th class="dir">Ofertas</th><th class="dir">Média/busca</th><th class="dir">Tempo médio</th><th>Último erro</th>
        </tr>
      </thead>
      <tbody id="tbody-metricas"></tbody>
    </table>
  </section>

  <div class="grade">
    <section class="painel">
      <h2>Buscas por dia</h2>
      <div id="met-grafico"></div>
    </section>
    <section class="painel">
      <h2>Termos mais buscados</h2>
      <table class="tabela">
        <thead><tr><th>Termo</th><th class="dir">Vezes</th></tr></thead>
        <tbody id="tbody-termos"></tbody>
      </table>
    </section>
  </div>
</main>

<!-- ---------- ADMINISTRAÇÃO (só com login, via /admin) ---------- -->
<main id="vista-admin" class="conteudo oculto">
  <div class="cabecalho-tela">
    <div><h1>Administração</h1><p class="sub">Contas cadastradas no sistema.</p></div>
    <button id="admin-atualizar" class="botao">Atualizar</button>
  </div>

  <section class="kpis">
    <article class="kpi"><h3>Usuários</h3><strong id="admin-total-usuarios">0</strong></article>
    <article class="kpi"><h3>Produtos</h3><strong id="admin-total-produtos">0</strong></article>
    <article class="kpi"><h3>Coletas</h3><strong id="admin-total-coletas">0</strong></article>
    <article class="kpi"><h3>Ofertas</h3><strong id="admin-total-ofertas">0</strong></article>
  </section>

  <section class="painel">
    <h2>Contas</h2>
    <table class="tabela">
      <thead>
        <tr><th>#</th><th>Nome</th><th>Login</th><th>Criada em</th>
          <th class="dir">Produtos</th><th class="dir">Coletas</th><th class="dir">Ofertas</th>
          <th class="dir">Sessões</th><th></th></tr>
      </thead>
      <tbody id="tbody-admin"></tbody>
    </table>
  </section>
</main>

<!-- ---------- LOGIN (aparece só em /admin) ---------- -->
<section id="tela-login" class="tela-login oculto">
  <div class="cartao-login">
    <div class="marca"><span>🎮</span> Administração</div>
    <p class="sub">O site é público. Esta área é só para gerenciar os produtos acompanhados.</p>
    <form id="form-entrar" class="form">
      <label>Usuário<input type="text" name="email" autocomplete="username" required></label>
      <label>Senha<input type="password" name="senha" autocomplete="current-password" required></label>
      <button class="botao primario" type="submit">Entrar</button>
    </form>
    <p id="aviso-login" class="aviso oculto"></p>
    <button id="btn-voltar-site" class="botao fantasma largo">← Voltar para o site</button>
  </div>
</section>

<footer class="rodape-site">
  <p class="rodape-frase">
    <span class="rodape-copy">&copy; 2026</span>
    <b>CHIPS</b>
    <span class="rodape-ponto">·</span>
    Engenharia de Software e Solu&ccedil;&otilde;es Digitais
  </p>
</footer>

<div id="toast" class="toast oculto"></div>
<script src="/app.js"></script>
<script src="/fundo.js"></script>
</body>
</html>
```

## public/app.js

Logica da interface: busca, paginacao, graficos e telas

```js
'use strict';

const App = (function () {
  const $ = (s) => document.querySelector(s);

  const dinheiro = (v) =>
    (v < 0 ? '-' : '') + 'R$ ' + Math.abs(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctFmt = (v) => (Number(v) || 0).toFixed(1).replace('.', ',') + '%';
  const dataHora = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  const el = (tag, classe, texto) => {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;
    return e;
  };
  const celula = (texto, classe) => el('td', classe, texto);
  const link = (texto, url, classe) => {
    const a = el('a', classe || 'link-externo', texto);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };

  let produtos = [];
  let detalhe = null;
  let usuarioAtual = null;
  let ehAdmin = false;
  let vistaAtual = 'busca';
  let ofertasDaBusca = [];   // resultado completo da ultima busca
  let pagina = 1;
  const POR_PAGINA = 10;

  /* ---------- utilitarios ---------- */
  let temporizadorToast;
  function toast(msg, erro) {
    const e = $('#toast');
    e.textContent = msg;
    e.className = 'toast' + (erro ? ' erro' : '');
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => e.classList.add('oculto'), 4200);
  }

  async function pedir(rota, opcoes) {
    const conf = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opcoes);
    if (conf.body && typeof conf.body !== 'string') conf.body = JSON.stringify(conf.body);
    const r = await fetch(rota, conf);
    const dados = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(dados.erro || 'Falha na requisição'), { status: r.status });
    return dados;
  }

  function dadosForm(form) {
    const o = {};
    new FormData(form).forEach((v, k) => { o[k] = v; });
    return o;
  }

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ================= NAVEGACAO ================= */
  function mostrar(vista) {
    vistaAtual = vista;
    $('#vista-busca').classList.toggle('oculto', vista !== 'busca');
    $('#vista-detalhe').classList.toggle('oculto', vista !== 'detalhe');
    $('#vista-metricas').classList.toggle('oculto', vista !== 'metricas');
    $('#vista-admin').classList.toggle('oculto', vista !== 'admin');
    if (vista === 'admin') carregarAdmin().catch((e) => toast(e.message, true));
    if (vista === 'metricas') carregarMetricas().catch((e) => toast(e.message, true));
    renderMenu();
    window.scrollTo({ top: 0 });
  }

  /* O visitante ve so a busca: o topo fica limpo.
     Quem administra ganha o menu para circular entre as telas.
     As metricas continuam acessiveis pelo endereco /metricas. */
  function renderMenu() {
    const menu = $('#menu');
    menu.innerHTML = '';
    if (!ehAdmin) return;

    const botao = (rotulo, vista) => {
      const b = el('button', 'item-menu' + (vistaAtual === vista ? ' ativo' : ''), rotulo);
      b.addEventListener('click', () => mostrar(vista));
      return b;
    };
    menu.appendChild(botao('Buscar', 'busca'));
    menu.appendChild(botao('Métricas', 'metricas'));
    menu.appendChild(botao('⚙️ Admin', 'admin'));
  }

  /* ---------- frase da capa: muda a cada visita ---------- */
  const FRASES = [
    'Farme desconto, não arrependimento.',
    'Preço cheio é dano no bolso. Compare antes do clique.',
    'Não pague preço de boss final em item de fase 1.',
    'Seu setup merece o melhor loot pelo menor preço.',
    'Antes de comprar, scaneie o mapa inteiro.',
    'Aqui o desconto não é drop raro: é garantido na comparação.',
    'Upgrade no setup, downgrade no preço.',
    'Missão: achar o menor preço. Recompensa: seu dinheiro de volta no bolso.',
  ];

  function escreverFrase() {
    const alvo = $('#frase');
    if (!alvo) return;
    const texto = FRASES[Math.floor(Math.random() * FRASES.length)];

    // efeito de digitação, como um terminal
    alvo.textContent = '';
    const cursor = el('span', 'cursor', '\u00a0');
    alvo.appendChild(cursor);

    let i = 0;
    const tique = setInterval(() => {
      if (i >= texto.length) { clearInterval(tique); setTimeout(() => cursor.remove(), 1800); return; }
      cursor.before(document.createTextNode(texto[i]));
      i += 1;
    }, 32);
  }

  /* ================= BUSCA PUBLICA ================= */
  function estado(texto, carregando) {
    const caixa = $('#estado-busca');
    caixa.classList.remove('oculto');
    caixa.innerHTML = '';
    if (carregando) caixa.appendChild(el('span', 'girando', '◐'));
    caixa.appendChild(el('span', '', texto));
  }

  function limparEstado() {
    $('#estado-busca').classList.add('oculto');
  }

  $('#form-busca').addEventListener('submit', (e) => {
    e.preventDefault();
    const termo = $('#campo-busca').value.trim();
    if (termo.length >= 2) buscar(termo);
  });

  async function buscar(termo) {
    $('#campo-busca').value = termo;
    $('#resultado').classList.add('oculto');
    // a capa centralizada da lugar ao layout com rolagem
    $('#vista-busca').classList.remove('centralizada');
    document.body.classList.remove('capa');
    pagina = 1;
    estado('Procurando "' + termo + '" nas lojas...', true);

    let busca;
    try {
      busca = await pedir('/api/buscas', { method: 'POST', body: { termo } });
    } catch (err) {
      estado(err.message, false);
      return;
    }

    // o resultado pode vir do proprio servidor ou do agente coletor
    const limite = Date.now() + 90000;
    while (busca.status !== 'pronta' && busca.status !== 'falhou' && Date.now() < limite) {
      estado('Consultando as lojas... (' + (busca.status === 'executando' ? 'em andamento' : 'na fila') + ')', true);
      await espera(2000);
      try {
        busca = await pedir('/api/buscas/' + busca.id);
      } catch (err) { break; }
    }

    if (busca.status !== 'pronta') {
      estado(
        busca.erro ||
        'Nenhuma loja respondeu a tempo. O coletor precisa estar rodando para atender buscas neste site.',
        false
      );
      return;
    }

    limparEstado();
    renderResultado(busca);
    carregarSugestoes();
  }

  function renderResultado(busca) {
    const r = busca.resultado || {};
    const comparacao = r.comparacao || { ranking: [], melhor: null, economia: 0, economia_pct: 0 };
    // mostra apenas as ofertas que combinam com o que foi pesquisado
    const termos = String(busca.termo || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '').split(' ').filter((t) => t.length >= 3 && t !== 'gamer');
    const combina = (titulo) => {
      if (!termos.length) return true;
      const alvo = String(titulo || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '');
      return termos.filter((t) => alvo.indexOf(t) !== -1).length / termos.length >= 0.7;
    };
    let ofertas = (r.fontes || []).reduce((acc, f) => acc.concat(f.ofertas || []), []).filter((o) => combina(o.titulo));
    ofertas.sort((a, b) => a.preco_total - b.preco_total);

    $('#resultado').classList.remove('oculto');

    const destino = $('#res-veredito');
    destino.innerHTML = '';

    if (!comparacao.melhor) {
      destino.appendChild(el('p', 'painel vazio', 'Nenhuma oferta encontrada para "' + busca.termo + '".'));
    } else {
      destino.appendChild(cartaoMelhor(comparacao, busca));
    }

    // detalhes tecnicos de cada fonte so interessam a quem administra
    if (ehAdmin) {
      (r.fontes || []).filter((f) => f.erro).forEach((f) => {
        destino.appendChild(el('p', 'aviso', f.fonte + ': ' + f.erro));
      });
    }

    ofertasDaBusca = ofertas;
    pagina = 1;
    renderPagina();
  }

  /* Mostra uma pagina da lista de ofertas e os controles de navegacao. */
  function renderPagina() {
    const total = ofertasDaBusca.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    if (pagina > paginas) pagina = paginas;

    const inicio = (pagina - 1) * POR_PAGINA;
    renderOfertas($('#tbody-ofertas'), ofertasDaBusca.slice(inicio, inicio + POR_PAGINA), $('#vazio-ofertas'), inicio);

    const caixa = $('#paginacao');
    caixa.innerHTML = '';
    caixa.classList.toggle('oculto', total <= POR_PAGINA);
    if (total <= POR_PAGINA) return;

    const irPara = (n) => {
      pagina = Math.min(paginas, Math.max(1, n));
      renderPagina();
      $('#resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const anterior = el('button', 'botao', '← Anterior');
    anterior.disabled = pagina === 1;
    anterior.addEventListener('click', () => irPara(pagina - 1));
    caixa.appendChild(anterior);

    const numeros = el('div', 'numeros');
    for (let n = 1; n <= paginas; n += 1) {
      const b = el('button', 'num' + (n === pagina ? ' ativa' : ''), String(n));
      b.addEventListener('click', () => irPara(n));
      numeros.appendChild(b);
    }
    caixa.appendChild(numeros);

    const proxima = el('button', 'botao', 'Próxima →');
    proxima.disabled = pagina === paginas;
    proxima.addEventListener('click', () => irPara(pagina + 1));
    caixa.appendChild(proxima);

    caixa.appendChild(el('span', 'pagina-info',
      'mostrando ' + (inicio + 1) + '–' + Math.min(inicio + POR_PAGINA, total) + ' de ' + total + ' ofertas'));
  }

  function cartaoMelhor(comparacao, busca) {
    const melhor = comparacao.melhor;
    const cartao = el('section', 'painel veredito bom');

    const topo = el('div', 'veredito-topo');
    const esq = el('div');
    esq.appendChild(el('h2', '', 'Mais vantajoso: ' + melhor.loja));
    esq.appendChild(el('p', 'veredito-preco', dinheiro(melhor.preco_total)));

    const detalhes = [];
    if (melhor.frete > 0) detalhes.push('inclui frete de ' + dinheiro(melhor.frete));
    else detalhes.push('frete grátis ou não informado');
    if (melhor.condicao !== 'novo') detalhes.push('produto ' + melhor.condicao);
    if (melhor.parcelas > 0) detalhes.push('até ' + melhor.parcelas + 'x');
    esq.appendChild(el('small', 'neutro', detalhes.join(' · ')));

    if (melhor.titulo) esq.appendChild(el('p', 'anuncio-titulo', melhor.titulo));
    if (melhor.url) esq.appendChild(link('Ir à loja e comprar ↗', melhor.url, 'botao primario comprar'));
    topo.appendChild(esq);

    const dir = el('div', 'ranking-lado');
    if (comparacao.ranking.length > 1) {
      dir.appendChild(el('h3', '', 'Comparação entre lojas'));
      dir.appendChild(barrasDeLojas(comparacao.ranking));
    }
    topo.appendChild(dir);
    cartao.appendChild(topo);

    if (comparacao.economia > 0) {
      cartao.appendChild(el('p', 'economia',
        'Comprando aqui em vez da loja mais cara você economiza ' + dinheiro(comparacao.economia) +
        ' (' + pctFmt(comparacao.economia_pct) + ').'));
    } else if (comparacao.mesmo_produto === false) {
      cartao.appendChild(el('p', 'dica',
        'As lojas trouxeram modelos diferentes para esta busca, então não dá para falar em economia: ' +
        'a lista abaixo mostra a opção mais barata de cada loja. Para comparar o mesmo produto, ' +
        'busque pelo modelo exato (ex.: "redragon kumara k552").'));
    }

    const maisBarato = comparacao.mais_barato;
    if (maisBarato && maisBarato.preco_total < melhor.preco_total) {
      cartao.appendChild(el('p', 'dica',
        'Existe oferta mais barata (' + dinheiro(maisBarato.preco_total) + ' na ' + maisBarato.loja +
        '), mas o sistema não a recomenda por causa da condição do produto ou da reputação do vendedor.'));
    }

    if (busca && busca.atualizado_em) {
      cartao.appendChild(el('small', 'neutro rodape-busca',
        'Consulta feita em ' + dataHora(busca.atualizado_em) + (busca.origem ? ' · coleta pelo ' + busca.origem : '')));
    }

    return cartao;
  }

  function barrasDeLojas(ranking) {
    const maximo = Math.max(...ranking.map((o) => o.preco_total));
    const ul = el('ul', 'barras');
    ranking.forEach((o, i) => {
      const li = el('li');
      li.appendChild(el('span', 'barra-rotulo', o.loja));
      const trilho = el('div', 'barra-trilho');
      const barra = el('div', 'barra ' + (i === 0 ? 'positivo' : ''));
      barra.style.width = (o.preco_total / maximo) * 100 + '%';
      trilho.appendChild(barra);
      li.appendChild(trilho);
      const valor = el('span', 'barra-valor');
      if (o.url) valor.appendChild(link(dinheiro(o.preco_total) + ' ↗', o.url));
      else valor.textContent = dinheiro(o.preco_total);
      li.appendChild(valor);
      ul.appendChild(li);
    });
    return ul;
  }

  function renderOfertas(tbody, ofertas, avisoVazio, deslocamento) {
    const base = deslocamento || 0;
    tbody.innerHTML = '';
    if (avisoVazio) avisoVazio.classList.toggle('oculto', ofertas.length > 0);

    ofertas.forEach((o, indice) => {
      const i = base + indice; // posicao na lista inteira, nao so na pagina
      const tr = el('tr', i === 0 ? 'melhor-linha' : '');
      tr.appendChild(celula(o.loja, 'ticker'));

      const tdTitulo = el('td', 'titulo-oferta');
      const curto = (o.titulo || '').length > 62 ? o.titulo.slice(0, 62).trim() + '…' : (o.titulo || 'ver anúncio');
      if (o.url) {
        const a = link(curto, o.url);
        a.title = o.titulo || '';
        tdTitulo.appendChild(a);
      } else {
        tdTitulo.textContent = curto;
      }
      tr.appendChild(tdTitulo);

      tr.appendChild(celula(o.condicao, o.condicao === 'usado' ? 'negativo' : ''));
      tr.appendChild(celula((o.vendedor || '—') + (o.vendidos ? ' · ' + o.vendidos + ' vendas' : '')));
      tr.appendChild(celula(dinheiro(o.preco), 'dir'));
      tr.appendChild(celula(o.frete > 0 ? dinheiro(o.frete) : 'grátis', 'dir'));
      tr.appendChild(celula(dinheiro(o.preco_total), 'dir ' + (i === 0 ? 'positivo' : '')));

      const tdAcao = el('td', 'dir');
      if (o.url) tdAcao.appendChild(link('comprar ↗', o.url, 'mini-botao'));
      tr.appendChild(tdAcao);

      tbody.appendChild(tr);
    });
  }

  async function carregarSugestoes() {
    try {
      const populares = await pedir('/api/buscas/populares');
      const caixa = $('#sugestoes');
      caixa.innerHTML = '';
      if (!populares.length) return;
      caixa.appendChild(el('span', 'sugestoes-titulo', 'Buscas recentes:'));
      populares.forEach((p) => {
        const b = el('button', 'chip', p.termo);
        b.addEventListener('click', () => buscar(p.termo));
        caixa.appendChild(b);
      });
    } catch (e) { /* sugestoes sao opcionais */ }
  }

  /* ================= PRODUTOS ACOMPANHADOS ================= */
  async function carregarProdutos() {
    try {
      produtos = await pedir('/api/produtos');
    } catch (e) {
      produtos = [];
    }
    $('#monitorados').classList.toggle('oculto', produtos.length === 0);

    const tb = $('#tbody-produtos');
    tb.innerHTML = '';

    produtos.forEach((p) => {
      const tr = el('tr');

      const tdNome = el('td');
      const botao = el('button', 'link-produto', p.nome);
      botao.addEventListener('click', () => abrirDetalhe(p.id));
      tdNome.appendChild(botao);
      tdNome.appendChild(el('small', 'termo', 'busca: ' + p.termo));
      tr.appendChild(tdNome);

      const tdCat = el('td');
      tdCat.appendChild(el('span', 'etiqueta', p.categoria));
      tr.appendChild(tdCat);

      const tdLoja = el('td');
      if (p.melhor_url) tdLoja.appendChild(link(p.melhor_loja + ' ↗', p.melhor_url));
      else tdLoja.textContent = p.melhor_loja || '—';
      tr.appendChild(tdLoja);

      const abaixoAlvo = p.preco_alvo > 0 && p.menor_preco > 0 && p.menor_preco <= p.preco_alvo;
      tr.appendChild(celula(p.menor_preco ? dinheiro(p.menor_preco) : '—', 'dir ' + (abaixoAlvo ? 'positivo' : '')));
      tr.appendChild(celula(String(p.ofertas), 'dir'));
      tr.appendChild(celula(dataHora(p.ultima_coleta)));

      const tdAcoes = el('td', 'dir');
      if (ehAdmin) {
        const btnColeta = el('button', 'mini', '🔄');
        btnColeta.title = 'Atualizar preços deste produto';
        btnColeta.addEventListener('click', () => coletar(p.id, btnColeta));
        const btnExcluir = el('button', 'mini', '🗑');
        btnExcluir.title = 'Parar de acompanhar';
        btnExcluir.addEventListener('click', async () => {
          if (!confirm('Remover "' + p.nome + '" e todo o histórico dele?')) return;
          try {
            await pedir('/api/produtos/' + p.id, { method: 'DELETE' });
            toast('Produto removido.');
            carregarProdutos();
          } catch (err) { toast(err.message, true); }
        });
        tdAcoes.append(btnColeta, btnExcluir);
      }
      tr.appendChild(tdAcoes);

      tb.appendChild(tr);
    });
  }

  async function abrirDetalhe(id) {
    try {
      detalhe = await pedir('/api/produtos/' + id);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    renderDetalhe();
    mostrar('detalhe');
  }

  $('#det-voltar').addEventListener('click', () => mostrar('busca'));
  $('#det-coletar').addEventListener('click', () => { if (detalhe) coletar(detalhe.produto.id); });

  function renderDetalhe() {
    const d = detalhe;
    $('#det-nome').textContent = d.produto.nome;
    $('#det-sub').textContent =
      d.produto.categoria + ' · busca: "' + d.produto.termo + '"' +
      (d.produto.preco_alvo > 0 ? ' · alvo ' + dinheiro(d.produto.preco_alvo) : '') +
      ' · última coleta ' + dataHora(d.ultima_coleta ? d.ultima_coleta.executado_em : '');

    const destino = $('#det-veredito');
    destino.innerHTML = '';

    if (!d.comparacao.melhor) {
      destino.appendChild(el('p', 'painel vazio', 'Ainda não há ofertas para este produto.'));
    } else {
      const cartao = cartaoMelhor(d.comparacao, null);
      cartao.classList.remove('bom');
      cartao.classList.add(d.momento.status);

      const momento = el('div', 'veredito-momento');
      momento.appendChild(el('span', 'selo ' + d.momento.status, d.momento.titulo));
      momento.appendChild(el('p', '', d.momento.texto));
      if (d.momento.dias > 1) {
        momento.appendChild(el('small', 'neutro',
          'mínimo ' + dinheiro(d.momento.minimo) + ' · mediana ' + dinheiro(d.momento.mediana) +
          ' · máximo ' + dinheiro(d.momento.maximo) + ' em ' + d.momento.dias + ' dia(s)'));
      }
      cartao.querySelector('.veredito-topo').appendChild(momento);
      destino.appendChild(cartao);
    }

    const ranking = $('#det-ranking');
    ranking.innerHTML = '';
    if (d.comparacao.ranking.length) {
      ranking.appendChild(barrasDeLojas(d.comparacao.ranking));
      ranking.appendChild(el('p', 'dica',
        'A ordem considera o preço final mais uma penalidade de risco para produto usado ou vendedor com reputação baixa.'));
    } else {
      ranking.appendChild(el('p', 'vazio', 'Sem lojas para comparar ainda.'));
    }

    renderGrafico(d.historico);
    renderOfertas($('#tbody-det-ofertas'), d.ofertas, $('#vazio-det-ofertas'));
  }

  function renderGrafico(historico) {
    const destino = $('#det-grafico');
    destino.innerHTML = '';
    if (!historico || historico.length < 2) {
      destino.appendChild(el('p', 'vazio', 'O gráfico aparece quando houver coletas em pelo menos dois dias diferentes.'));
      return;
    }

    const largura = 560, altura = 220, margem = { topo: 16, dir: 12, baixo: 28, esq: 62 };
    const valores = historico.map((h) => h.minimo);
    const min = Math.min(...valores), max = Math.max(...valores);
    const faixa = max - min || max * 0.1 || 1;
    const x = (i) => margem.esq + (i / (historico.length - 1)) * (largura - margem.esq - margem.dir);
    const y = (v) => margem.topo + (1 - (v - min + faixa * 0.1) / (faixa * 1.2)) * (altura - margem.topo - margem.baixo);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + largura + ' ' + altura);
    svg.setAttribute('class', 'grafico');

    [0, 0.5, 1].forEach((f) => {
      const valor = min + faixa * f;
      const linha = document.createElementNS(ns, 'line');
      linha.setAttribute('x1', margem.esq); linha.setAttribute('x2', largura - margem.dir);
      linha.setAttribute('y1', y(valor)); linha.setAttribute('y2', y(valor));
      linha.setAttribute('stroke', '#232a36');
      svg.appendChild(linha);
      const rotulo = document.createElementNS(ns, 'text');
      rotulo.setAttribute('x', 6); rotulo.setAttribute('y', y(valor) + 4);
      rotulo.setAttribute('fill', '#97a1b2'); rotulo.setAttribute('font-size', '11');
      rotulo.textContent = dinheiro(valor);
      svg.appendChild(rotulo);
    });

    const linha = document.createElementNS(ns, 'polyline');
    linha.setAttribute('points', historico.map((h, i) => x(i) + ',' + y(h.minimo)).join(' '));
    linha.setAttribute('fill', 'none');
    linha.setAttribute('stroke', '#4c8dff');
    linha.setAttribute('stroke-width', '2');
    svg.appendChild(linha);

    historico.forEach((h, i) => {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', x(i)); c.setAttribute('cy', y(h.minimo)); c.setAttribute('r', '3');
      c.setAttribute('fill', h.minimo === min ? '#22c55e' : '#4c8dff');
      const t = document.createElementNS(ns, 'title');
      t.textContent = h.dia.split('-').reverse().join('/') + ': ' + dinheiro(h.minimo);
      c.appendChild(t);
      svg.appendChild(c);
    });

    [0, historico.length - 1].forEach((i) => {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', x(i)); t.setAttribute('y', altura - 8);
      t.setAttribute('fill', '#97a1b2'); t.setAttribute('font-size', '11');
      t.setAttribute('text-anchor', i === 0 ? 'start' : 'end');
      t.textContent = historico[i].dia.slice(5).split('-').reverse().join('/');
      svg.appendChild(t);
    });

    destino.appendChild(svg);
    destino.appendChild(el('p', 'dica', 'Cada ponto é o menor preço observado naquele dia, somando todas as lojas.'));
  }

  /* ================= METRICAS ================= */
  const segundos = (v) => (Number(v) || 0).toFixed(1).replace('.', ',') + 's';

  async function carregarMetricas() {
    const m = await pedir('/api/metricas');

    $('#met-buscas').textContent = m.buscas_total;
    $('#met-buscas-sub').textContent = m.buscas_prontas + ' concluídas nas últimas ' + m.buscas_analisadas;

    $('#met-tempo').textContent = segundos(m.tempo_medio_s);
    $('#met-tempo-sub').textContent = 'mediana ' + segundos(m.tempo_mediano_s);

    $('#met-ofertas').textContent = m.ofertas_brutas;
    $('#met-ofertas-sub').textContent = m.ofertas_relevantes + ' relevantes · ' +
      (Number(m.descartadas_pct) || 0).toFixed(0) + '% descartadas por relevância';

    $('#met-historico').textContent = m.ofertas_historico;
    $('#met-historico-sub').textContent = m.produtos_monitorados + ' produto(s) acompanhado(s)';

    const tb = $('#tbody-metricas');
    tb.innerHTML = '';
    m.lojas.forEach((l) => {
      const tr = el('tr');
      tr.appendChild(celula(l.loja, 'ticker'));
      tr.appendChild(celula(String(l.consultas), 'dir'));
      const taxa = (Number(l.taxa_sucesso) || 0).toFixed(0) + '%';
      tr.appendChild(celula(taxa, 'dir ' + (l.taxa_sucesso >= 80 ? 'positivo' : l.taxa_sucesso >= 50 ? '' : 'negativo')));
      tr.appendChild(celula(String(l.ofertas), 'dir'));
      tr.appendChild(celula((Number(l.media_ofertas) || 0).toFixed(1).replace('.', ','), 'dir'));
      tr.appendChild(celula(segundos(l.tempo_medio_s), 'dir'));
      const tdErro = el('td', 'neutro', l.ultimo_erro ? l.ultimo_erro.slice(0, 48) + '…' : '—');
      tdErro.title = l.ultimo_erro || '';
      tr.appendChild(tdErro);
      tb.appendChild(tr);
    });

    const tt = $('#tbody-termos');
    tt.innerHTML = '';
    m.termos.forEach((t) => {
      const tr = el('tr');
      const td = el('td');
      const b = el('button', 'link-produto', t.termo);
      b.addEventListener('click', () => { mostrar('busca'); buscar(t.termo); });
      td.appendChild(b);
      tr.appendChild(td);
      tr.appendChild(celula(String(t.vezes), 'dir'));
      tt.appendChild(tr);
    });

    desenharBarrasDia(m.por_dia);
  }

  function desenharBarrasDia(dias) {
    const destino = $('#met-grafico');
    destino.innerHTML = '';
    if (!dias || !dias.length) {
      destino.appendChild(el('p', 'vazio', 'Ainda não há buscas registradas.'));
      return;
    }
    const maximo = Math.max(...dias.map((d) => d.buscas));
    const ul = el('ul', 'barras');
    dias.forEach((d) => {
      const li = el('li');
      li.appendChild(el('span', 'barra-rotulo', d.dia.slice(5).split('-').reverse().join('/')));
      const trilho = el('div', 'barra-trilho');
      const barra = el('div', 'barra');
      barra.style.width = (d.buscas / maximo) * 100 + '%';
      trilho.appendChild(barra);
      li.appendChild(trilho);
      li.appendChild(el('span', 'barra-valor', String(d.buscas)));
      ul.appendChild(li);
    });
    destino.appendChild(ul);
  }

  const btnMetricas = $('#met-atualizar');
  if (btnMetricas) btnMetricas.addEventListener('click', () => carregarMetricas().catch((e) => toast(e.message, true)));

  /* ================= ADMINISTRACAO ================= */
  async function coletar(id, botao) {
    if (botao) { botao.disabled = true; botao.textContent = '⏳'; }
    try {
      const r = await pedir('/api/produtos/' + id + '/coletar', { method: 'POST' });
      const falhas = r.relatorio.filter((f) => f.erro);
      if (falhas.length) toast(falhas.map((f) => f.fonte + ': ' + f.erro).join(' | '), true);
      else toast(r.relatorio.reduce((t, f) => t + f.encontrados, 0) + ' oferta(s) coletada(s).');
      await carregarProdutos();
      if (detalhe && detalhe.produto.id === id) { detalhe = r.detalhe; renderDetalhe(); }
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (botao) { botao.disabled = false; botao.textContent = '🔄'; }
    }
  }

  const formProduto = $('#form-produto');
  if (formProduto) {
    formProduto.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const p = await pedir('/api/produtos', { method: 'POST', body: dadosForm(e.target) });
        e.target.reset();
        await carregarProdutos();
        toast('Produto adicionado ao acompanhamento.');
        coletar(p.id);
      } catch (err) { toast(err.message, true); }
    });
  }

  const btnColetarTodos = $('#btn-coletar-todos');
  if (btnColetarTodos) {
    btnColetarTodos.addEventListener('click', async (e) => {
      if (!produtos.length) { toast('Nenhum produto acompanhado.', true); return; }
      e.target.disabled = true;
      for (const p of produtos) await coletar(p.id);
      e.target.disabled = false;
      toast('Coleta concluída.');
    });
  }

  async function carregarAdmin() {
    const usuarios = await pedir('/api/admin/usuarios');
    const soma = (campo) => usuarios.reduce((t, u) => t + u[campo], 0);
    $('#admin-total-usuarios').textContent = usuarios.length;
    $('#admin-total-produtos').textContent = soma('produtos');
    $('#admin-total-coletas').textContent = soma('coletas');
    $('#admin-total-ofertas').textContent = soma('ofertas');

    const tb = $('#tbody-admin');
    tb.innerHTML = '';
    usuarios.forEach((u) => {
      const tr = el('tr');
      tr.appendChild(celula('#' + u.id));

      const tdNome = el('td', '', u.nome);
      if (u.admin) {
        const et = el('span', 'etiqueta oficial', 'admin');
        et.style.marginLeft = '6px';
        tdNome.appendChild(et);
      }
      tr.appendChild(tdNome);

      tr.appendChild(celula(u.email));
      tr.appendChild(celula(u.criado_em.slice(0, 10).split('-').reverse().join('/')));
      tr.appendChild(celula(String(u.produtos), 'dir'));
      tr.appendChild(celula(String(u.coletas), 'dir'));
      tr.appendChild(celula(String(u.ofertas), 'dir'));
      tr.appendChild(celula(u.sessoes > 0 ? 'ativa' : '—', 'dir ' + (u.sessoes > 0 ? 'positivo' : 'neutro')));

      const tdAcoes = el('td', 'dir');
      const btnSenha = el('button', 'mini', '🔑');
      btnSenha.title = 'Definir nova senha';
      btnSenha.addEventListener('click', async () => {
        const senha = prompt('Nova senha para ' + u.nome + ' (mínimo 8 caracteres):');
        if (!senha) return;
        try {
          await pedir('/api/admin/usuarios/' + u.id + '/senha', { method: 'POST', body: { senha } });
          toast('Senha redefinida.');
          if (usuarioAtual && u.id === usuarioAtual.id) location.reload();
          else carregarAdmin();
        } catch (err) { toast(err.message, true); }
      });
      tdAcoes.appendChild(btnSenha);
      tr.appendChild(tdAcoes);

      tb.appendChild(tr);
    });
  }

  const btnAdminAtualizar = $('#admin-atualizar');
  if (btnAdminAtualizar) btnAdminAtualizar.addEventListener('click', () => carregarAdmin().catch((e) => toast(e.message, true)));

  /* ---------- login (so em /admin) ---------- */
  $('#form-entrar').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await pedir('/api/login', { method: 'POST', body: dadosForm(e.target) });
      location.href = '/';
    } catch (err) {
      const aviso = $('#aviso-login');
      aviso.textContent = err.message;
      aviso.classList.remove('oculto');
    }
  });

  $('#btn-voltar-site').addEventListener('click', () => { location.href = '/'; });

  $('#btn-sair').addEventListener('click', async () => {
    await pedir('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });

  /* ================= INICIO ================= */
  (async function iniciar() {
    try {
      usuarioAtual = await pedir('/api/eu');
      ehAdmin = Boolean(usuarioAtual && usuarioAtual.admin);
    } catch {
      usuarioAtual = null;
      ehAdmin = false;
    }

    const caminho = location.pathname.replace(/\/+$/, '');
    const querAdmin = caminho === '/admin';
    const querMetricas = caminho === '/metricas';

    if (querAdmin && !usuarioAtual) {
      $('#tela-login').classList.remove('oculto');
      document.querySelector('header').classList.add('oculto');
      return;
    }

    document.querySelectorAll('.so-admin').forEach((e) => e.classList.toggle('oculto', !ehAdmin));
    $('#btn-sair').classList.toggle('oculto', !usuarioAtual);
    $('#ola').textContent = usuarioAtual ? usuarioAtual.nome : '';



    await carregarProdutos();
    carregarSugestoes();
    escreverFrase();
    mostrar(querAdmin && ehAdmin ? 'admin' : querMetricas ? 'metricas' : 'busca');
    $('#campo-busca').focus();
  })();

  return { pedir, toast, buscar };
})();
```

## public/fundo.js

Cena animada da capa desenhada em canvas

```js
'use strict';
/* Cena animada da capa: synthwave gamer.
   -------------------------------------------------------------------------
   Sol neon fatiado, grade em perspectiva correndo para o horizonte, campo de
   estrelas piscando e riscos de luz cruzando a tela. Tudo desenhado em canvas:
   nenhum GIF, video ou imagem externa — carrega instantaneo e nunca quebra.
   Quem tem "reduzir movimento" ligado ve a cena parada. */

(function () {
  const tela = document.getElementById('fundo-gamer');
  if (!tela) return;

  const ctx = tela.getContext('2d');
  const menosMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const AZUL = '76, 141, 255';
  const ROXO = '168, 85, 247';
  const ROSA = '236, 72, 153';

  let largura = 0;
  let altura = 0;
  let horizonte = 0;
  let estrelas = [];
  let riscos = [];
  let faiscas = [];

  function dimensionar() {
    const escala = Math.min(window.devicePixelRatio || 1, 2);
    largura = tela.clientWidth;
    altura = tela.clientHeight;
    horizonte = altura * 0.62;
    tela.width = Math.floor(largura * escala);
    tela.height = Math.floor(altura * escala);
    ctx.setTransform(escala, 0, 0, escala, 0, 0);

    const quantasEstrelas = Math.min(160, Math.round((largura * horizonte) / 5200));
    estrelas = new Array(quantasEstrelas).fill(0).map(() => ({
      x: Math.random() * largura,
      y: Math.random() * horizonte,
      raio: Math.random() * 1.4 + 0.3,
      fase: Math.random() * Math.PI * 2,
      ritmo: 0.6 + Math.random() * 1.6,
    }));

    faiscas = new Array(Math.min(40, Math.round(largura / 34))).fill(0).map(() => novaFaisca(true));
    riscos = [];
  }

  function novaFaisca(inicial) {
    return {
      x: Math.random() * largura,
      y: inicial ? horizonte + Math.random() * (altura - horizonte) : altura + 8,
      tamanho: 1 + Math.random() * 2.5,
      velocidade: 0.25 + Math.random() * 0.7,
      brilho: 0.25 + Math.random() * 0.5,
      cor: Math.random() > 0.7 ? ROSA : AZUL,
      balanco: Math.random() * Math.PI * 2,
    };
  }

  /* ---------- sol neon fatiado ---------- */
  function desenharSol(t) {
    const raio = Math.min(largura * 0.16, 190);
    const cx = largura / 2;
    const cy = horizonte - raio * 0.28;
    const pulso = 1 + Math.sin(t / 900) * 0.02;

    ctx.save();

    // halo
    const halo = ctx.createRadialGradient(cx, cy, raio * 0.2, cx, cy, raio * 2.5);
    halo.addColorStop(0, 'rgba(' + ROSA + ',0.16)');
    halo.addColorStop(0.45, 'rgba(' + ROXO + ',0.07)');
    halo.addColorStop(1, 'rgba(' + ROXO + ',0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - raio * 2.6, cy - raio * 2.6, raio * 5.2, raio * 5.2);

    // disco
    ctx.beginPath();
    ctx.arc(cx, cy, raio * pulso, 0, Math.PI * 2);
    ctx.clip();

    const corpo = ctx.createLinearGradient(0, cy - raio, 0, cy + raio);
    corpo.addColorStop(0, 'rgba(255, 210, 120, 0.78)');
    corpo.addColorStop(0.42, 'rgba(' + ROSA + ',0.62)');
    corpo.addColorStop(1, 'rgba(' + ROXO + ',0.30)');
    ctx.fillStyle = corpo;
    ctx.fillRect(cx - raio, cy - raio, raio * 2, raio * 2);

    // fatias horizontais, mais grossas embaixo (marca do estilo synthwave)
    ctx.globalCompositeOperation = 'destination-out';
    let y = cy - raio * 0.05;
    let espessura = 2;
    while (y < cy + raio) {
      ctx.fillRect(cx - raio, y, raio * 2, espessura);
      y += espessura + Math.max(3, raio * 0.055);
      espessura += 0.9;
    }
    ctx.restore();
  }

  /* ---------- grade em perspectiva ---------- */
  function desenharGrade(t) {
    const avanco = (t / 16) % 70;

    // brilho do chao
    const chao = ctx.createLinearGradient(0, horizonte, 0, altura);
    chao.addColorStop(0, 'rgba(' + ROXO + ',0.10)');
    chao.addColorStop(1, 'rgba(' + AZUL + ',0.02)');
    ctx.fillStyle = chao;
    ctx.fillRect(0, horizonte, largura, altura - horizonte);

    ctx.lineWidth = 1.1;

    // horizontais
    for (let i = 0; i < 30; i += 1) {
      const passo = (i * 70 + avanco) / 70;
      const y = horizonte + Math.pow(passo, 2.15) * 13;
      if (y > altura + 30) continue;
      const forca = Math.max(0, 1 - (y - horizonte) / (altura - horizonte));
      ctx.strokeStyle = 'rgba(' + AZUL + ',' + (0.34 * forca + 0.05).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(largura, y);
      ctx.stroke();
    }

    // verticais convergindo
    const centro = largura / 2;
    for (let i = -16; i <= 16; i += 1) {
      const xBase = centro + i * (largura / 11);
      const distancia = Math.abs(i) / 16;
      ctx.strokeStyle = 'rgba(' + AZUL + ',' + (0.22 - distancia * 0.12).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(centro + (xBase - centro) * 0.02, horizonte);
      ctx.lineTo(xBase, altura + 40);
      ctx.stroke();
    }

    // linha do horizonte, acesa
    ctx.strokeStyle = 'rgba(' + ROSA + ',0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, horizonte);
    ctx.lineTo(largura, horizonte);
    ctx.stroke();

    const brilhoHorizonte = ctx.createLinearGradient(0, horizonte - 26, 0, horizonte + 26);
    brilhoHorizonte.addColorStop(0, 'rgba(' + ROSA + ',0)');
    brilhoHorizonte.addColorStop(0.5, 'rgba(' + ROSA + ',0.14)');
    brilhoHorizonte.addColorStop(1, 'rgba(' + ROSA + ',0)');
    ctx.fillStyle = brilhoHorizonte;
    ctx.fillRect(0, horizonte - 26, largura, 52);
  }

  /* ---------- estrelas ---------- */
  function desenharEstrelas(t) {
    estrelas.forEach((e) => {
      const brilho = 0.25 + Math.abs(Math.sin(t / 1000 * e.ritmo + e.fase)) * 0.6;
      ctx.fillStyle = 'rgba(226, 232, 240,' + brilho.toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.raio, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /* ---------- riscos de luz atravessando o ceu ---------- */
  function atualizarRiscos() {
    if (riscos.length < 2 && Math.random() < 0.012) {
      const daEsquerda = Math.random() > 0.5;
      riscos.push({
        x: daEsquerda ? -60 : largura + 60,
        y: Math.random() * horizonte * 0.7,
        direcao: daEsquerda ? 1 : -1,
        velocidade: 4 + Math.random() * 5,
        comprimento: 90 + Math.random() * 110,
        vida: 1,
      });
    }

    riscos = riscos.filter((r) => {
      r.x += r.velocidade * r.direcao;
      r.y += r.velocidade * 0.22;
      r.vida -= 0.004;
      return r.vida > 0 && r.x > -240 && r.x < largura + 240;
    });

    riscos.forEach((r) => {
      const risco = ctx.createLinearGradient(r.x, r.y, r.x - r.comprimento * r.direcao, r.y - r.comprimento * 0.22);
      risco.addColorStop(0, 'rgba(255,255,255,' + (0.5 * r.vida).toFixed(2) + ')');
      risco.addColorStop(0.4, 'rgba(' + AZUL + ',' + (0.3 * r.vida).toFixed(2) + ')');
      risco.addColorStop(1, 'rgba(' + AZUL + ',0)');
      ctx.strokeStyle = risco;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x - r.comprimento * r.direcao, r.y - r.comprimento * 0.22);
      ctx.stroke();
    });
  }

  /* ---------- faiscas subindo do chao ---------- */
  function desenharFaiscas() {
    faiscas.forEach((f, i) => {
      f.y -= f.velocidade;
      f.balanco += 0.012;
      const x = f.x + Math.sin(f.balanco) * 10;
      if (f.y < horizonte - 40) faiscas[i] = novaFaisca(false);

      ctx.fillStyle = 'rgba(' + f.cor + ',' + f.brilho.toFixed(2) + ')';
      ctx.fillRect(x, f.y, f.tamanho, f.tamanho);
    });
  }

  /* ---------- escurece o centro para o texto ficar legivel ---------- */
  function desenharVinheta() {
    const v = ctx.createRadialGradient(largura / 2, altura * 0.42, 40, largura / 2, altura * 0.42, Math.max(largura, altura) * 0.62);
    v.addColorStop(0, 'rgba(10, 13, 20, 0.82)');
    v.addColorStop(0.55, 'rgba(10, 13, 20, 0.35)');
    v.addColorStop(1, 'rgba(10, 13, 20, 0)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, largura, altura);
  }

  function cena(t) {
    ctx.clearRect(0, 0, largura, altura);
    desenharEstrelas(t);
    desenharSol(t);
    desenharGrade(t);
    desenharFaiscas();
    atualizarRiscos();
    desenharVinheta();
  }

  function quadro(t) {
    cena(t);
    if (document.hidden) setTimeout(() => requestAnimationFrame(quadro), 500);
    else requestAnimationFrame(quadro);
  }

  dimensionar();
  window.addEventListener('resize', dimensionar);

  if (menosMovimento) cena(0);
  else requestAnimationFrame(quadro);
})();
```

## public/estilo.css

Visual do sistema

```css
:root {
  --fundo: #0e1117;
  --fundo-2: #151a23;
  --borda: #232a36;
  --texto: #e6e9ef;
  --texto-fraco: #97a1b2;
  --destaque: #4c8dff;
  --verde: #22c55e;
  --vermelho: #f05252;
  --acao: #e8253f;         /* vermelho de acao: botao principal e frase da capa */
  --acao-clara: #ff4257;
  --raio: 12px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--fundo);
  color: var(--texto);
  font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
}

.oculto { display: none !important; }
.dir { text-align: right; }

/* ---------- login ---------- */
.tela-login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: radial-gradient(900px 500px at 50% -10%, #1b2740, var(--fundo));
}
.cartao-login {
  width: 100%;
  max-width: 380px;
  background: var(--fundo-2);
  border: 1px solid var(--borda);
  border-radius: 16px;
  padding: 28px;
}
.marca { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.marca.pequena { font-size: 16px; }
.sub { color: var(--texto-fraco); font-size: 13px; margin: 8px 0 20px; }

.abas { display: flex; gap: 6px; background: #0f141c; padding: 4px; border-radius: 10px; margin-bottom: 18px; }
.aba {
  flex: 1; padding: 8px; border: 0; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--texto-fraco); font: inherit; font-weight: 600;
}
.aba.ativa { background: var(--destaque); color: #fff; }

/* ---------- formulários ---------- */
.form { display: grid; gap: 12px; }
.form.compacto { gap: 10px; }
.linha { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
label { display: grid; gap: 5px; font-size: 12px; color: var(--texto-fraco); font-weight: 600; }
label small { font-weight: 400; }
input, select {
  background: #0f141c; border: 1px solid var(--borda); color: var(--texto);
  border-radius: 8px; padding: 9px 10px; font: inherit; width: 100%;
}
input:focus, select:focus { outline: 2px solid var(--acao); outline-offset: -1px; }

.botao {
  border: 1px solid var(--borda); background: #1b2230; color: var(--texto);
  padding: 9px 14px; border-radius: 8px; cursor: pointer; font: inherit; font-weight: 600;
}
.botao:hover { border-color: var(--destaque); }
.botao.primario {
  background: var(--acao);
  border-color: var(--acao);
  color: #fff;
  box-shadow: 0 0 0 0 rgba(232, 37, 63, .5);
  transition: box-shadow .25s ease, background .25s ease;
}
.botao.primario:hover {
  background: var(--acao-clara);
  border-color: var(--acao-clara);
  box-shadow: 0 0 18px rgba(232, 37, 63, .35);
}
.botao.fantasma { background: transparent; }
.mini { background: transparent; border: 0; color: var(--texto-fraco); cursor: pointer; font-size: 15px; padding: 2px 6px; border-radius: 6px; }
.mini:hover { color: var(--texto); background: #1b2230; }

.aviso { margin: 14px 0 0; padding: 10px; border-radius: 8px; background: #3a1d20; color: #ffc9c9; font-size: 13px; }

/* ---------- layout ---------- */
.topo {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 24px;
  position: sticky; top: 0; z-index: 5;

  /* preto liso, com um fio de luz na borda de cima */
  background: #0a0a0b;
  border-bottom: 1px solid #191a1d;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.04),
    0 4px 14px rgba(0,0,0,.35);
}
.topo-dir { display: flex; align-items: center; gap: 12px; }
.ola { color: var(--texto-fraco); font-size: 13px; }
.conteudo { max-width: 1180px; margin: 0 auto; padding: 22px 24px 60px; display: grid; gap: 18px; }

.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.kpi { background: var(--fundo-2); border: 1px solid var(--borda); border-radius: var(--raio); padding: 16px; }
.kpi h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--texto-fraco); text-transform: uppercase; letter-spacing: .4px; }
.kpi strong { font-size: 24px; font-variant-numeric: tabular-nums; }
.variacao { display: block; margin-top: 4px; font-size: 13px; font-weight: 600; }
.positivo { color: var(--verde); }
.negativo { color: var(--vermelho); }
.neutro { color: var(--texto-fraco); }

.grade { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
.painel { background: var(--fundo-2); border: 1px solid var(--borda); border-radius: var(--raio); padding: 18px; }
.painel h2 { margin: 0 0 14px; font-size: 15px; }

/* ---------- alocação ---------- */
.alocacao { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
.rosca { width: 150px; height: 150px; transform: rotate(-90deg); }
.legenda { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; flex: 1; min-width: 160px; }
.legenda li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ponto { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.legenda span.valor { margin-left: auto; color: var(--texto-fraco); font-variant-numeric: tabular-nums; }

/* ---------- tabelas ---------- */
.rolagem { overflow-x: auto; }  /* mantido so para telas estreitas */
.rolagem.alta { max-height: none; overflow-y: visible; }
.tabela { width: 100%; border-collapse: collapse; font-size: 13px; }
.tabela th {
  text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .4px;
  color: var(--texto-fraco); padding: 8px; border-bottom: 1px solid var(--borda); white-space: nowrap;
}
.tabela td { padding: 9px 8px; border-bottom: 1px solid #1b212c; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tabela tr:last-child td { border-bottom: 0; }
.tabela tbody tr:hover { background: #1a212c; }
.ticker { font-weight: 700; }
.ticker small { display: block; font-weight: 400; color: var(--texto-fraco); }
.etiqueta { background: #1b2230; border: 1px solid var(--borda); padding: 2px 8px; border-radius: 20px; font-size: 11px; }
.editavel { background: #0f141c; border: 1px solid var(--borda); border-radius: 6px; padding: 4px 6px; width: 90px; text-align: right; color: var(--texto); font: inherit; font-variant-numeric: tabular-nums; }
.vazio { color: var(--texto-fraco); font-size: 13px; text-align: center; padding: 18px 0 4px; margin: 0; }
.rodape { color: var(--texto-fraco); font-size: 12px; text-align: center; margin: 6px 0 0; }
code { background: #0f141c; padding: 1px 5px; border-radius: 4px; }

/* ---------- toast ---------- */
.toast {
  position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
  background: #1b2230; border: 1px solid var(--borda); padding: 11px 18px;
  border-radius: 10px; font-size: 14px; z-index: 20; box-shadow: 0 8px 24px #0008;
}
.toast.erro { border-color: var(--vermelho); color: #ffc9c9; }

@media (max-width: 860px) {
  .kpis { grid-template-columns: repeat(2, 1fr); }
  .grade { grid-template-columns: 1fr; }
}
@media (max-width: 520px) {
  .kpis { grid-template-columns: 1fr; }
  .linha { grid-template-columns: 1fr; }
  .conteudo, .topo { padding-left: 14px; padding-right: 14px; }
}

/* ================= MENU ================= */
.menu { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; justify-content: center; }
.item-menu {
  background: transparent; border: 1px solid transparent; color: var(--texto-fraco);
  padding: 7px 13px; border-radius: 8px; cursor: pointer; font: inherit; font-weight: 600; font-size: 13px;
}
.item-menu:hover { color: var(--texto); background: #1b2230; }
.item-menu.ativo { color: #fff; background: var(--destaque); }

/* ================= TELAS MONTADAS ================= */
.cabecalho-tela { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.cabecalho-tela h1 { margin: 0; font-size: 21px; }
.cabecalho-tela .sub { margin: 4px 0 0; }

.telas-grade { display: grid; grid-template-columns: repeat(12, 1fr); gap: 18px; align-items: start; }
.bloco.tam-p { grid-column: span 4; }
.bloco.tam-m { grid-column: span 6; }
.bloco.tam-g { grid-column: span 12; }
.bloco h2 { margin: 0 0 12px; font-size: 15px; }
.kpi-valor { font-size: 28px; font-variant-numeric: tabular-nums; display: block; }
.resumo-linha { margin: 12px 0 0; font-size: 12px; color: var(--texto-fraco); }
.titulo-previa { font-size: 13px; text-transform: uppercase; letter-spacing: .5px; color: var(--texto-fraco); margin: 22px 0 12px; }

/* barras */
.barras { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.barras li { display: grid; grid-template-columns: 90px 1fr auto; gap: 10px; align-items: center; font-size: 13px; }
.barra-rotulo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.barra-trilho { background: #0f141c; border-radius: 6px; height: 12px; position: relative; overflow: hidden; }
.barra { height: 100%; border-radius: 6px; background: var(--destaque); transition: width .25s; }
.barra.negativo { background: var(--vermelho); }
.barra.positivo { background: var(--verde); }
.barra-valor { font-variant-numeric: tabular-nums; font-size: 12px; }

/* metas */
.metas { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.metas .meta-topo { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px; }
.metas .barra-trilho { height: 14px; overflow: visible; }
.metas .barra { border-radius: 6px 0 0 6px; }
.marca-alvo { position: absolute; top: -3px; width: 2px; height: 20px; background: var(--texto); border-radius: 2px; }
.metas small { display: block; margin-top: 5px; font-size: 11px; }

.texto-livre p { margin: 0 0 8px; font-size: 14px; }
.texto-livre p:last-child { margin-bottom: 0; }
.quadro-livre { width: 100%; border: 1px dashed var(--borda); border-radius: 8px; background: #0f141c; }

/* ================= LABORATÓRIO ================= */
.lab-layout { display: grid; grid-template-columns: 290px 1fr; gap: 18px; align-items: start; }

.lab-lateral h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .4px; color: var(--texto-fraco); }
.lab-lateral h2.espaco { margin-top: 22px; }
.lab-principal { display: grid; gap: 18px; }

.telas-lista { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.item-tela-nome {
  width: 100%; text-align: left; background: #0f141c; border: 1px solid var(--borda);
  color: var(--texto); border-radius: 8px; padding: 9px 10px; cursor: pointer; font: inherit;
  display: grid; gap: 3px;
}
.item-tela-nome:hover { border-color: var(--destaque); }
.item-tela.ativa .item-tela-nome { border-color: var(--destaque); background: #16213a; }
.item-tela-nome small { color: var(--texto-fraco); font-size: 11px; }
.item-tela-nome .etiqueta { justify-self: start; font-size: 10px; }
.etiqueta.oficial { background: #14321f; border-color: #1f6b3a; color: #7ee2a8; }

.paleta { display: grid; gap: 6px; }
.item-paleta {
  text-align: left; background: #0f141c; border: 1px solid var(--borda); color: var(--texto);
  border-radius: 8px; padding: 9px 10px; cursor: pointer; font: inherit; display: grid; gap: 2px;
}
.item-paleta:hover { border-color: var(--destaque); background: #16213a; }
.item-paleta small { color: var(--texto-fraco); font-size: 11px; line-height: 1.35; }

.barra-acoes { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
.barra-acoes .espacador { flex: 1; }
.botao.perigo:hover { border-color: var(--vermelho); color: #ffc9c9; }

.blocos-lista { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.cartao-bloco { border: 1px solid var(--borda); border-radius: 10px; background: #0f141c; padding: 12px; }
.cartao-topo { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.cartao-info { display: grid; gap: 2px; }
.cartao-info small { color: var(--texto-fraco); font-size: 11px; }
.cartao-acoes { display: flex; gap: 2px; }
.cartao-acoes .mini:disabled { opacity: .3; cursor: default; }
.cartao-campos { display: grid; gap: 10px; margin-top: 12px; }
.cartao-campos textarea {
  background: #0b0f16; border: 1px solid var(--borda); color: var(--texto); border-radius: 8px;
  padding: 9px 10px; font: 13px/1.5 Consolas, "Courier New", monospace; width: 100%; resize: vertical;
}
.cartao-campos textarea:focus { outline: 2px solid var(--destaque); outline-offset: -1px; }
.rotulo-campo { font-size: 12px; color: var(--texto-fraco); font-weight: 600; }
.caixa-colunas { display: grid; grid-template-columns: repeat(auto-fill, minmax(135px, 1fr)); gap: 6px; }
.check { flex-direction: row; display: flex; align-items: center; gap: 6px; color: var(--texto); font-weight: 400; font-size: 13px; }
.check input { width: auto; }
.dica { font-size: 12px; color: var(--texto-fraco); background: #16213a; border-left: 3px solid var(--destaque); padding: 8px 10px; border-radius: 6px; margin: 0; }

@media (max-width: 1000px) {
  .lab-layout { grid-template-columns: 1fr; }
  .lab-lateral { position: static; max-height: none; }
  .bloco.tam-p, .bloco.tam-m { grid-column: span 6; }
}
@media (max-width: 700px) {
  .topo { flex-wrap: wrap; gap: 10px; }
  .menu { order: 3; width: 100%; justify-content: flex-start; }
  .bloco.tam-p, .bloco.tam-m, .bloco.tam-g { grid-column: span 12; }
}

/* ================= COMPARADOR DE PREÇOS ================= */
.link-produto {
  background: none; border: 0; padding: 0; color: var(--texto); font: inherit; font-weight: 700;
  cursor: pointer; text-align: left;
}
.link-produto:hover { color: var(--destaque); text-decoration: underline; }
.termo { display: block; color: var(--texto-fraco); font-weight: 400; font-size: 11px; }
.link-externo { color: var(--destaque); text-decoration: none; }
.link-externo:hover { text-decoration: underline; }
.titulo-oferta { max-width: 330px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.melhor-linha { background: #13251c; }

/* veredito */
.veredito { border-left: 4px solid var(--destaque); }
.veredito.otimo, .veredito.bom { border-left-color: var(--verde); }
.veredito.ruim { border-left-color: var(--vermelho); }
.veredito-topo { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.veredito-topo h2 { margin: 0 0 6px; }
.veredito-preco { font-size: 34px; font-weight: 700; margin: 0 0 4px; font-variant-numeric: tabular-nums; }
.veredito-momento { max-width: 340px; text-align: right; }
.veredito-momento p { margin: 8px 0 4px; font-size: 13px; color: var(--texto-fraco); }
.selo { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; background: #1b2230; border: 1px solid var(--borda); }
.selo.otimo, .selo.bom { background: #14321f; border-color: #1f6b3a; color: #7ee2a8; }
.selo.ruim { background: #3a1d20; border-color: #7a2c31; color: #ffc9c9; }
.selo.sem_historico { color: var(--texto-fraco); }
.economia { margin: 14px 0 0; font-size: 13px; color: var(--verde); font-weight: 600; }
.veredito .dica, .veredito .neutro, .veredito .positivo { margin-top: 10px; font-size: 13px; }

/* busca rápida */
.lista-ofertas { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.lista-ofertas li { background: #0f141c; border: 1px solid var(--borda); border-radius: 8px; padding: 10px; display: grid; gap: 4px; }
.lista-ofertas li.destaque { border-color: var(--verde); }
.oferta-topo { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
.oferta-topo .preco { font-weight: 700; font-variant-numeric: tabular-nums; }
.lista-ofertas small { color: var(--texto-fraco); font-size: 12px; line-height: 1.35; }

/* gráfico de histórico */
.grafico { width: 100%; height: auto; }

.aviso-fontes { border-left: 4px solid var(--vermelho); display: grid; gap: 6px; }
.aviso-fontes b { font-size: 15px; }
.aviso-fontes p { margin: 0; font-size: 13px; color: var(--texto-fraco); }
.aviso-fontes .comando { background: #0b0f16; border: 1px solid var(--borda); padding: 8px 12px; border-radius: 8px; font-family: Consolas, monospace; justify-self: start; }
.aviso-fontes small { color: var(--texto-fraco); font-size: 11px; }

.comprar { display: inline-block; margin-top: 12px; text-decoration: none; }
.anuncio-titulo { margin: 10px 0 0; font-size: 13px; color: var(--texto-fraco); max-width: 420px; }
.barra-valor .link-externo { font-variant-numeric: tabular-nums; }

.largo { width: 100%; margin-top: 10px; }
.tabela { table-layout: auto; }

/* ================= BUSCA PÚBLICA ================= */
.heroi { text-align: center; padding: 26px 0 6px; }
.heroi h1 { font-size: 32px; margin: 0 0 8px; }
.heroi .sub { max-width: 620px; margin: 0 auto 22px; font-size: 14px; }
.caixa-busca { display: flex; gap: 10px; max-width: 640px; margin: 0 auto; }
.caixa-busca input {
  flex: 1; font-size: 16px; padding: 14px 16px; border-radius: 10px;
  background: var(--fundo-2); border: 1px solid var(--borda);
}
.caixa-busca button { padding: 14px 26px; font-size: 15px; border-radius: 10px; }
.sugestoes { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; margin-top: 16px; }
.sugestoes-titulo { color: var(--texto-fraco); font-size: 12px; align-self: center; margin-right: 4px; }
.chip {
  background: var(--fundo-2); border: 1px solid var(--borda); color: var(--texto-fraco);
  border-radius: 20px; padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.chip:hover { border-color: var(--destaque); color: var(--texto); }
#estado-busca { display: flex; align-items: center; gap: 10px; justify-content: center; font-size: 14px; color: var(--texto-fraco); }
.girando { display: inline-block; animation: girar 1s linear infinite; font-size: 18px; color: var(--destaque); }
@keyframes girar { to { transform: rotate(360deg); } }
.ranking-lado { min-width: 280px; flex: 1; }
.ranking-lado h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .4px; color: var(--texto-fraco); margin: 0 0 10px; }
.rodape-busca { display: block; margin-top: 14px; }
.mini-botao {
  background: #1b2230; border: 1px solid var(--borda); color: var(--texto); text-decoration: none;
  padding: 4px 10px; border-radius: 6px; font-size: 12px; white-space: nowrap;
}
.mini-botao:hover { border-color: var(--destaque); }
#resultado { display: grid; gap: 18px; }

/* ---------- tela inicial: busca centralizada na janela ---------- */
.conteudo.centralizada {
  align-content: center;
  padding-top: 0;
  padding-bottom: 0;
}
.conteudo.centralizada .heroi { padding: 0; }
/* a lista de acompanhados so entra na rolagem depois da dobra */
.conteudo.centralizada #monitorados { display: none; }

/* ---------- paginacao ---------- */
.paginacao {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--borda);
}
.paginacao .pagina-info { color: var(--texto-fraco); font-size: 13px; }
.paginacao .botao { padding: 6px 14px; font-size: 13px; }
.paginacao .botao:disabled { opacity: .4; cursor: default; border-color: var(--borda); }
.paginacao .numeros { display: flex; gap: 4px; }
.paginacao .num {
  background: #0f141c; border: 1px solid var(--borda); color: var(--texto-fraco);
  border-radius: 6px; min-width: 30px; padding: 5px 8px; cursor: pointer; font: inherit; font-size: 13px;
}
.paginacao .num:hover { border-color: var(--destaque); color: var(--texto); }
.paginacao .num.ativa { background: var(--destaque); border-color: var(--destaque); color: #fff; }

/* ---------- frase da capa ---------- */
.frase {
  margin: 18px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--acao-clara);
  letter-spacing: .2px;
  text-shadow: 0 0 18px rgba(232, 37, 63, .28);
}
.frase .cursor {
  display: inline-block;
  width: 9px;
  margin-left: 2px;
  background: var(--acao-clara);
  animation: piscar 1.1s steps(1) infinite;
}
@keyframes piscar { 50% { opacity: 0; } }

/* ---------- estrutura: rodape sempre no fim ---------- */
body { display: flex; flex-direction: column; min-height: 100vh; }
main.conteudo { flex: 1 0 auto; }
.tela-login { flex: 1 0 auto; }

/* ---------- rodape ---------- */
.rodape-site {
  flex: none;
  margin-top: 32px;

  /* mesmo preto liso do topo */
  background: #0a0a0b;
  border-top: 1px solid #191a1d;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
}












.rodape-ponto { opacity: .5; }


/* na capa o rodape encosta no fim sem empurrar a busca do centro */
body.capa .rodape-site { margin-top: 0; }

/* ---------- rodape: uma linha, centralizada ---------- */
.rodape-frase {
  margin: 0;
  padding: 18px 24px;
  text-align: center;
  font-size: 12px;
  letter-spacing: .3px;
  color: var(--texto-fraco);
}
.rodape-frase b {
  color: #e9edf5;
  font-weight: 700;
  letter-spacing: 1px;
}

/* ---------- marca da empresa no topo ---------- */
.marca-empresa { display: flex; align-items: baseline; gap: 9px; }
.marca-sigla {
  font-size: 19px;
  font-weight: 800;
  letter-spacing: 4px;
  color: #fff;
}
.marca-tipo {
  font-size: 10px;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--texto-fraco);
  border-left: 1px solid var(--borda);
  padding-left: 9px;
}
@media (max-width: 520px) {
  .marca-tipo { display: none; }
}

.rodape-copy { opacity: .75; margin-right: 2px; }
.rodape-frase b { margin: 0 2px; }

/* ---------- fundo animado da capa ---------- */
#fundo-gamer {
  position: fixed;
  inset: 53px 0 0 0;          /* comeca abaixo do topo */
  width: 100%;
  height: calc(100vh - 53px);
  z-index: 0;
  pointer-events: none;
  opacity: 1;
  transition: opacity .6s ease;
}
/* depois da busca o fundo some, para nao competir com os resultados */
body:not(.capa) #fundo-gamer { opacity: 0; }

/* o conteudo fica sempre acima da animacao */
header.topo, main.conteudo, .rodape-site, .tela-login { position: relative; z-index: 1; }

/* ---------- entrada da capa: os elementos surgem em sequencia ---------- */
@keyframes surgir {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: none; }
}
@keyframes surgirEscala {
  from { opacity: 0; transform: translateY(18px) scale(.97); }
  to   { opacity: 1; transform: none; }
}
@keyframes aparecer {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes descerMarca {
  from { opacity: 0; transform: translateX(-12px); }
  to   { opacity: 1; transform: none; }
}

body.capa .heroi h1      { animation: surgir .75s cubic-bezier(.2,.75,.3,1) both; }
body.capa .heroi .sub    { animation: surgir .75s cubic-bezier(.2,.75,.3,1) .12s both; }
body.capa .caixa-busca   { animation: surgirEscala .8s cubic-bezier(.2,.75,.3,1) .24s both; }
body.capa #frase         { animation: surgir .7s ease .55s both; }
body.capa #sugestoes     { animation: surgir .7s ease .7s both; }
body.capa #fundo-gamer   { animation: aparecer 1.6s ease .1s both; }
.marca-empresa           { animation: descerMarca .7s cubic-bezier(.2,.75,.3,1) both; }
.rodape-site             { animation: aparecer 1s ease .8s both; }

/* o campo de busca ganha foco sozinho: um leve destaque ao chegar */
@keyframes respirar {
  0%, 100% { box-shadow: 0 0 0 0 rgba(232, 37, 63, 0); }
  50%      { box-shadow: 0 0 22px 0 rgba(232, 37, 63, .22); }
}
body.capa .caixa-busca .botao.primario { animation: respirar 2.8s ease-in-out 1.2s 2; }

@media (prefers-reduced-motion: reduce) {
  body.capa .heroi h1, body.capa .heroi .sub, body.capa .caixa-busca,
  body.capa #frase, body.capa #sugestoes, body.capa #fundo-gamer,
  .marca-empresa, .rodape-site, body.capa .caixa-busca .botao.primario {
    animation: none;
  }
}
```

---

# Configuracao e rotinas

## package.json

Scripts do projeto

```json
{
  "name": "comparador-precos-gamer",
  "version": "2.0.0",
  "description": "TCC - sistema de apoio a decisao de compra: compara precos de equipamentos gamer em varias lojas",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "coletar": "node agente.js",
    "token": "node agente.js --token"
  },
  "engines": {
    "node": ">=22.5"
  }
}
```

## render.yaml

Deploy no Render

```yaml
services:
  - type: web
    name: meus-investimentos
    runtime: node
    plan: free               # ATENCAO: no plano free nao existe disco persistente.
    buildCommand: ""         # sem dependencias para instalar
    startCommand: node server.js
    envVars:
      - key: NODE_ENV
        value: production
      # Credenciais do app criado em https://developers.mercadolivre.com.br
      # Preencha os valores no painel do Render (Environment), nao aqui no repositorio.
      - key: ML_CLIENT_ID
        sync: false
      - key: ML_CLIENT_SECRET
        sync: false
      # Senha do administrador (login: admin). Sem ela, a senha padrao e "admin".
      - key: ADMIN_SENHA
        sync: false
# Para o historico de precos sobreviver a deploys e reinicios, troque para:
#   plan: starter
#   e acrescente:
#     - key: DB_PATH
#       value: /var/data/precos.db
#   disk:
#     name: dados
#     mountPath: /var/data
#     sizeGB: 1
```

## INICIAR.bat

Sobe o sistema local

```bat
@echo off
cd /d "%~dp0"
start "" http://localhost:3000
node server.js
pause
```

## ATENDER-BUSCAS.bat

Agente em modo servico

```bat
@echo off
cd /d "%~dp0"
set SERVIDOR=https://meus-investimentos-x7dn.onrender.com
set COLETOR_TOKEN=COLE_O_TOKEN_AQUI
node agente.js --servico
```

## COLETA-DIARIA.bat

Coleta diaria agendada

```bat
@echo off
REM Coleta diaria de precos dos produtos acompanhados.
REM Roda no seu computador (rede brasileira) e alimenta o historico do site.
cd /d "%~dp0"
set SERVIDOR=http://localhost:3000,https://meus-investimentos-x7dn.onrender.com
set COLETOR_TOKEN=COLE_O_TOKEN_AQUI
node agente.js >> coleta-diaria.log 2>&1
```
