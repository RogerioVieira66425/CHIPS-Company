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

/* ---------- acesso as rotas de escrita ----------
   O site e publico e nao tem login nem senha. O que muda dados - produtos
   acompanhados, coleta e ingestao - e autenticado pelo token do agente,
   que roda na maquina de quem mantem o sistema. */
const COLETOR_TOKEN = String(process.env.COLETOR_TOKEN || '').trim();

function tokenValido(req) {
  if (!COLETOR_TOKEN) return false;
  const enviado = Buffer.from(String(req.headers['x-coletor-token'] || ''));
  const esperado = Buffer.from(COLETOR_TOKEN);
  return enviado.length === esperado.length && crypto.timingSafeEqual(enviado, esperado);
}

/* ---------- catalogo ----------
   Os produtos acompanhados pertencem a uma unica vitrine, criada no primeiro
   boot. A coluna user_id continua nas tabelas por causa do historico ja
   gravado. */
const VITRINE = { id: 0 };

async function garantirVitrine() {
  const existente = (await db.get('SELECT id FROM usuarios WHERE admin = 1 ORDER BY id LIMIT 1')) ||
    (await db.get('SELECT id FROM usuarios ORDER BY id LIMIT 1'));
  if (existente) { VITRINE.id = existente.id; return; }
  const info = (await db.run('INSERT INTO usuarios (email, nome, senha_hash, salt, criado_em, admin) VALUES (?,?,?,?,?,1)', 'vitrine', 'Vitrine', '', '', new Date().toISOString()));
  VITRINE.id = Number(info.lastInsertRowid);
}

/* ---------- limite de buscas por visitante ----------
   Cada busca vira uma consulta as seis lojas, feita pelo agente a partir de
   uma rede residencial. Sem limite, um robo usaria o site para martelar as
   lojas em nome de quem hospeda o agente. */
const JANELA_BUSCAS_MS = 10 * 60 * 1000;
const MAX_BUSCAS = Number(process.env.MAX_BUSCAS) || 30;   // por IP, ajustavel por variavel de ambiente
const buscasPorIp = new Map();

function ipDoPedido(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

function podeBuscar(req) {
  const agora = Date.now();
  const ip = ipDoPedido(req);
  const reg = buscasPorIp.get(ip);

  if (!reg || agora - reg.desde > JANELA_BUSCAS_MS) buscasPorIp.set(ip, { contagem: 1, desde: agora });
  else if (reg.contagem >= MAX_BUSCAS) return false;
  else reg.contagem += 1;

  // limpeza preguicosa: sem isso o mapa so cresce
  if (buscasPorIp.size > 2000) {
    buscasPorIp.forEach((v, k) => { if (agora - v.desde > JANELA_BUSCAS_MS) buscasPorIp.delete(k); });
  }
  return true;
}

/* Endereco de anuncio so serve se for http(s): um "javascript:" vindo de uma
   pagina de loja viraria execucao de script dentro do nosso site. */
const urlSegura = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

/* ---------- busca e analise ----------
   As ofertas vem do banco (ia.js). Os coletores de loja continuam no projeto,
   mas nao sao mais chamados pelo site. */
let cacheDiagnostico = { quando: 0, dados: null };
// registro de quando o agente antigo deu sinal: ainda lido pela fila de ingestao
let ultimoSinalDoAgente = 0;
const analise = require('./analise.js');
const ia = require('./ia.js');

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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
};

const num = (v) => {
  const n = Number(String(v === undefined || v === null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

/* ---------- produtos, coleta e historico ---------- */
/* Todo o catalogo publico pertence a vitrine. */
const donoDaVitrine = () => VITRINE.id;

async function listarProdutos(userId) {
  const produtos = (await db.all('SELECT * FROM produtos WHERE user_id = ? ORDER BY nome', userId));
  return Promise.all(produtos.map(async (p) => {
    const melhor = (await db.get('SELECT loja, preco_total, coletado_em, url, titulo FROM ofertas WHERE produto_id = ? ' +
      'AND coleta_id IN (SELECT c.id FROM coletas c WHERE c.produto_id = ? AND c.executado_em = ' +
    '  (SELECT MAX(c2.executado_em) FROM coletas c2 WHERE c2.produto_id = c.produto_id AND c2.fonte = c.fonte)) ' +
      'ORDER BY preco_total LIMIT 1', p.id, p.id));
    const total = (await db.get('SELECT COUNT(*) AS n FROM ofertas WHERE produto_id = ? ' +
      'AND coleta_id IN (SELECT c.id FROM coletas c WHERE c.produto_id = ? AND c.executado_em = ' +
      '  (SELECT MAX(c2.executado_em) FROM coletas c2 WHERE c2.produto_id = c.produto_id AND c2.fonte = c.fonte))', p.id, p.id));
    return Object.assign({}, p, {
      menor_preco: melhor ? melhor.preco_total : 0,
      melhor_loja: melhor ? melhor.loja : '',
      melhor_url: melhor ? melhor.url : '',
      melhor_titulo: melhor ? melhor.titulo : '',
      ultima_coleta: melhor ? melhor.coletado_em : '',
      ofertas: total ? total.n : 0,
    });
  }));
}

async function produtoPorId(userId, id) {
  return (await listarProdutos(userId)).find((p) => p.id === id) || null;
}

/* Serie diaria: menor preco observado em cada dia (base do grafico e do veredito). */
async function historicoDiario(produtoId, dias) {
  return (await db.all('SELECT substr(coletado_em, 1, 10) AS dia, MIN(preco_total) AS minimo, AVG(preco_total) AS media, COUNT(*) AS amostras ' +
    'FROM ofertas WHERE produto_id = ? GROUP BY dia ORDER BY dia DESC LIMIT ?', produtoId, dias || 90)).reverse();
}

async function detalheProduto(userId, id) {
  const produto = (await db.get('SELECT * FROM produtos WHERE id = ? AND user_id = ?', id, userId));
  if (!produto) return null;

  const ultimaColeta = (await db.get('SELECT * FROM coletas WHERE produto_id = ? ORDER BY executado_em DESC, id DESC LIMIT 1', id));

  // ofertas da coleta mais recente de cada fonte
  const ofertas = (await db.all('SELECT * FROM ofertas WHERE produto_id = ? ' +
    'AND coleta_id IN (SELECT c.id FROM coletas c WHERE c.produto_id = ? AND c.executado_em = ' +
    '  (SELECT MAX(c2.executado_em) FROM coletas c2 WHERE c2.produto_id = c.produto_id AND c2.fonte = c.fonte)) ' +
    'ORDER BY preco_total', id, id));

  const historico = await historicoDiario(id, 90);
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

/* Pesquisa o produto no banco e grava uma coleta por loja encontrada. */
async function coletarPrecos(userId, produto) {
  const agora = new Date().toISOString();
  const relatorio = [];

  // a coleta le o banco de ofertas: uma "fonte" por loja encontrada
  const pesquisa = await ia.pesquisar(produto.termo);
  for (const fonte of pesquisa.fontes) {
    // o historico guarda as 40 ofertas mais baratas de cada loja, nao o catalogo inteiro
    const ofertas = fonte.ofertas.slice(0, 40);
    const erro = '';

    const coleta = (await db.run('INSERT INTO coletas (produto_id, user_id, fonte, executado_em, encontrados, erro) VALUES (?,?,?,?,?,?)', produto.id, userId, fonte.fonte, agora, ofertas.length, erro));

    for (const o of ofertas) {
      await db.run(
        'INSERT INTO ofertas (coleta_id, produto_id, user_id, loja, titulo, preco, preco_de, frete, preco_total, condicao, vendedor, reputacao, vendidos, parcelas, url, id_externo, manual, coletado_em) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)',
        Number(coleta.lastInsertRowid), produto.id, userId, o.loja, o.titulo, o.preco, Number(o.preco_de) || 0,
        o.frete, o.preco_total, o.condicao, o.vendedor, o.reputacao, o.vendidos, o.parcelas, urlSegura(o.url), o.id_externo, agora
      );
    }

    relatorio.push({ fonte: fonte.fonte, encontrados: ofertas.length, erro });
  }

  (await db.run('UPDATE produtos SET atualizado_em = ? WHERE id = ?', agora, produto.id));
  return { executado_em: agora, relatorio };
}

/* ---------- buscas publicas ----------
   O visitante pede uma busca e ela e respondida pelo banco de ofertas. As lojas
   nao sao mais consultadas em tempo real. */
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

/* So vale reaproveitar um resultado bom: se a coleta daquela hora voltou
   vazia - lojas fora do ar, navegador que nao abriu -, o visitante seguinte
   receberia a mesma tela vazia por meia hora. */
function resultadoUtil(linha) {
  try {
    const r = JSON.parse(linha.resultado || '{}');
    return Number(r.relevantes) > 0;
  } catch (e) {
    return false;
  }
}

async function buscaRecente(termo) {
  const linha = (await db.get("SELECT * FROM buscas WHERE termo = ? AND status = 'pronta' ORDER BY atualizado_em DESC LIMIT 1", termo));
  if (!linha) return null;
  if (Date.now() - new Date(linha.atualizado_em).getTime() >= VALIDADE_BUSCA_MS) return null;
  return resultadoUtil(linha) ? linha : null;
}

/* A busca sai da fila quando o agente a pega. Se ele cair no meio do caminho,
   ninguem devolveria a linha: por isso, a cada visita do agente, o que esta
   em execucao ha tempo demais volta para a fila, e o pedido antigo - cujo
   visitante ja foi embora - e encerrado. */
const EXECUCAO_MAX_MS = 3 * 60 * 1000;
const PENDENTE_MAX_MS = 15 * 60 * 1000;

async function devolverBuscasTravadas() {
  const travadas = new Date(Date.now() - EXECUCAO_MAX_MS).toISOString();
  (await db.run("UPDATE buscas SET status = 'pendente' WHERE status = 'executando' AND atualizado_em < ?", travadas));

  const antigas = new Date(Date.now() - PENDENTE_MAX_MS).toISOString();
  (await db.run("UPDATE buscas SET status = 'falhou', erro = ?, atualizado_em = ? WHERE status = 'pendente' AND criado_em < ?", 'A busca expirou antes de o coletor atender.', new Date().toISOString(), antigas));
}

/* Tenta executar aqui mesmo. Devolve true quando conseguiu falar com alguma loja. */
async function executarBuscaLocalmente(id, termo) {
  const pesquisa = await ia.pesquisar(termo);
  await db.run(
    "UPDATE buscas SET status = 'pronta', resultado = ?, erro = '', origem = 'banco', atualizado_em = ? WHERE id = ?",
    JSON.stringify(pesquisa), new Date().toISOString(), id
  );
  return true;
}

/* ---------- metricas de operacao (capitulo de resultados do TCC) ---------- */
async function calcularMetricas() {
  const buscas = (await db.all("SELECT termo, status, origem, resultado, criado_em, atualizado_em FROM buscas ORDER BY id DESC LIMIT 500"));

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

  const porDia = (await db.all("SELECT substr(criado_em, 1, 10) AS dia, COUNT(*) AS buscas FROM buscas GROUP BY dia ORDER BY dia DESC LIMIT 30")).reverse();

  const termos = (await db.all("SELECT termo, COUNT(*) AS vezes FROM buscas GROUP BY termo ORDER BY vezes DESC, MAX(id) DESC LIMIT 10"));

  return {
    buscas_total: (await db.get('SELECT COUNT(*) AS n FROM buscas')).n,
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
    produtos_monitorados: (await db.get('SELECT COUNT(*) AS n FROM produtos')).n,
    ofertas_historico: (await db.get('SELECT COUNT(*) AS n FROM ofertas')).n,
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
    const fontes = (await ia.resumo()).por_loja.map((l) => ({
      fonte: l.loja, ok: true, mensagem: l.ofertas + ' oferta(s) no banco.',
    }));
    cacheDiagnostico = { quando: agora, dados: { verificado_em: new Date().toISOString(), fontes } };
    return json(res, 200, cacheDiagnostico.dados);
  }

  /* ----- ingestao pelo agente coletor local -----
     O agente roda no computador do usuario (rede brasileira), consulta as lojas
     e envia o resultado para ca. Autentica com o header X-Coletor-Token. */
  if (rota.indexOf('/api/ingestao') === 0) {
    if (!COLETOR_TOKEN) return json(res, 503, { erro: 'Ingestao desativada: defina COLETOR_TOKEN no servidor.' });
    if (!tokenValido(req)) return json(res, 401, { erro: 'Token do coletor invalido.' });

    /* fila de buscas pedidas pelos visitantes */
    if (rota === '/api/ingestao/buscas' && metodo === 'GET') {
      ultimoSinalDoAgente = Date.now();
      await devolverBuscasTravadas();
      const linhas = (await db.all("SELECT id, termo FROM buscas WHERE status = 'pendente' ORDER BY id LIMIT 10"));
      const agora = new Date().toISOString();
      for (const b of linhas) {
        await db.run("UPDATE buscas SET status = 'executando', atualizado_em = ? WHERE id = ?", agora, b.id);
      }
      return json(res, 200, linhas);
    }

    let mIng = rota.match(/^\/api\/ingestao\/buscas\/(\d+)$/);
    if (mIng && metodo === 'POST') {
      const id = Number(mIng[1]);
      const linha = (await db.get('SELECT * FROM buscas WHERE id = ?', id));
      if (!linha) return json(res, 404, { erro: 'Busca nao encontrada.' });

      const c = await lerCorpo(req);
      const fontes = (Array.isArray(c.fontes) ? c.fontes : []).map((f) => Object.assign({}, f, {
        ofertas: (Array.isArray(f.ofertas) ? f.ofertas : []).map((o) => Object.assign({}, o, { url: urlSegura(o.url) })),
      }));
      const todas = fontes.reduce((acc, f) => acc.concat(f.ofertas), []);
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

      (await db.run('UPDATE buscas SET status = ?, resultado = ?, erro = ?, origem = ?, atualizado_em = ? WHERE id = ?', encontrou || !c.erro ? 'pronta' : 'falhou',
          JSON.stringify(resultado),
          String(c.erro || ''),
          'agente',
          new Date().toISOString(),
          id));
      return json(res, 200, { ok: true, ofertas: todas.length });
    }

    if (rota === '/api/ingestao/pendentes' && metodo === 'GET') {
      const linhas = (await db.all('SELECT id, user_id, nome, termo FROM produtos ORDER BY id'));
      return json(res, 200, linhas);
    }

    /* cria (ou reaproveita) um produto na vitrine, para espelhar o que existe
       no servidor local. */
    if (rota === '/api/ingestao/produtos' && metodo === 'POST') {
      const c = await lerCorpo(req);
      const nome = String(c.nome || '').trim();
      const termo = String(c.termo || '').trim() || nome;
      if (!nome) return json(res, 400, { erro: 'Informe o nome do produto.' });

      const dono = { id: VITRINE.id };
      const existente = (await db.get('SELECT * FROM produtos WHERE user_id = ? AND termo = ?', dono.id, termo));
      if (existente) return json(res, 200, { criado: false, produto: existente });

      const agora = new Date().toISOString();
      const info = (await db.run('INSERT INTO produtos (user_id, nome, termo, categoria, preco_alvo, criado_em, atualizado_em) VALUES (?,?,?,?,?,?,?)', dono.id, nome, termo, String(c.categoria || 'Outros'), num(c.preco_alvo) || 0, agora, agora));
      const produto = (await db.get('SELECT * FROM produtos WHERE id = ?', Number(info.lastInsertRowid)));
      return json(res, 201, { criado: true, produto });
    }

    if (rota === '/api/ingestao' && metodo === 'POST') {
      const corpo = await lerCorpo(req);
      const produto = (await db.get('SELECT * FROM produtos WHERE id = ?', Number(corpo.produto_id)));
      if (!produto) return json(res, 404, { erro: 'Produto nao encontrado.' });
      const fonte = String(corpo.fonte || '').trim();
      if (!fonte) return json(res, 400, { erro: 'Informe a fonte.' });

      const ofertas = Array.isArray(corpo.ofertas) ? corpo.ofertas : [];
      const agora = new Date().toISOString();
      const coleta = (await db.run('INSERT INTO coletas (produto_id, user_id, fonte, executado_em, encontrados, erro) VALUES (?,?,?,?,?,?)', produto.id, produto.user_id, fonte, agora, ofertas.length, String(corpo.erro || '')));

      let gravadas = 0;
      for (const o of ofertas) {
        const preco = num(o.preco);
        const frete = num(o.frete) || 0;
        if (!Number.isFinite(preco) || preco <= 0) continue;
        await db.run(
          'INSERT INTO ofertas (coleta_id, produto_id, user_id, loja, titulo, preco, preco_de, frete, preco_total, condicao, vendedor, reputacao, vendidos, parcelas, url, id_externo, manual, coletado_em) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)',
          Number(coleta.lastInsertRowid), produto.id, produto.user_id,
          String(o.loja || fonte), String(o.titulo || ''), preco, num(o.preco_de) || 0, frete, preco + frete,
          o.condicao === 'usado' ? 'usado' : 'novo', String(o.vendedor || ''), String(o.reputacao || ''),
          Number(o.vendidos) || 0, Number(o.parcelas) || 0, urlSegura(o.url), String(o.id_externo || ''), agora
        );
        gravadas += 1;
      }

      (await db.run('UPDATE produtos SET atualizado_em = ? WHERE id = ?', agora, produto.id));
      return json(res, 201, { ok: true, produto: produto.nome, fonte, gravadas });
    }

    return json(res, 404, { erro: 'Rota de ingestao nao encontrada.' });
  }

  /* ---------- busca publica: qualquer visitante pode pesquisar ---------- */
  if (rota === '/api/buscas' && metodo === 'POST') {
    const { termo } = await lerCorpo(req);
    const t = normalizarTermo(termo);
    if (t.length < 2) return json(res, 400, { erro: 'Digite o que voce quer procurar.' });

    // resultado guardado nao custa consulta nenhuma: responde antes do limite
    const recente = await buscaRecente(t);
    if (recente) return json(res, 200, formatarBusca(recente));

    if (!podeBuscar(req)) {
      return json(res, 429, { erro: 'Muitas buscas seguidas deste endereco. Tente de novo em alguns minutos.' });
    }

    const agora = new Date().toISOString();
    const info = (await db.run("INSERT INTO buscas (termo, status, resultado, erro, origem, criado_em, atualizado_em) VALUES (?,'pendente','','','',?,?)", t, agora, agora));
    const id = Number(info.lastInsertRowid);

    await executarBuscaLocalmente(id, t);

    const linha = (await db.get('SELECT * FROM buscas WHERE id = ?', id));
    return json(res, linha.status === 'pronta' ? 200 : 202, formatarBusca(linha));
  }

  let mBusca = rota.match(/^\/api\/buscas\/(\d+)$/);
  if (mBusca && metodo === 'GET') {
    const linha = (await db.get('SELECT * FROM buscas WHERE id = ?', Number(mBusca[1])));
    if (!linha) return json(res, 404, { erro: 'Busca nao encontrada.' });
    return json(res, 200, formatarBusca(linha));
  }

  if (rota === '/api/metricas' && metodo === 'GET') {
    return json(res, 200, await calcularMetricas());
  }

  if (rota === '/api/buscas/populares' && metodo === 'GET') {
    const linhas = (await db.all("SELECT termo, MAX(atualizado_em) AS quando, COUNT(*) AS vezes FROM buscas " +
      "WHERE status = 'pronta' GROUP BY termo ORDER BY quando DESC LIMIT 12"));
    return json(res, 200, linhas);
  }

  /* ---------- dados enriquecidos pela IA (Supabase, so leitura) ----------
     Respondem 503 enquanto DATABASE_URL nao estiver definida no servidor. */
  if (rota.indexOf('/api/ia/') === 0 && metodo === 'GET') {
    const parametros = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    try {
      if (rota === '/api/ia/resumo') return json(res, 200, await ia.resumo());
      if (rota === '/api/ia/ofertas') return json(res, 200, await ia.ofertas(parametros));
      if (rota === '/api/ia/sugerir') return json(res, 200, await ia.sugerir(parametros.q || ''));
      if (rota === '/api/ia/analise') {
        const dados = await ia.analiseDoProduto(parametros.produto, parametros.titulo);
        return dados ? json(res, 200, dados) : json(res, 404, { erro: 'Produto nao encontrado na base.' });
      }
    } catch (e) {
      return json(res, 500, { erro: 'Falha ao ler o banco: ' + e.message });
    }
  }

  /* ---------- leitura publica: o catalogo da vitrine ---------- */
  if (rota === '/api/fontes' && metodo === 'GET') {
    const lojas = await db.all('SELECT DISTINCT loja AS nome FROM ofertas_dia ORDER BY nome');
    return json(res, 200, lojas.map((l) => ({ nome: l.nome, configurado: true })));
  }

  if (rota === '/api/produtos' && metodo === 'GET') {
    return json(res, 200, await listarProdutos(VITRINE.id));
  }

  const mPublico = rota.match(/^\/api\/produtos\/(\d+)$/);
  if (mPublico && metodo === 'GET') {
    const detalhe = await detalheProduto(VITRINE.id, Number(mPublico[1]));
    if (!detalhe) return json(res, 404, { erro: 'Produto nao encontrado.' });
    return json(res, 200, detalhe);
  }

  /* ---------- daqui para baixo, so com o token do agente ---------- */
  if (!tokenValido(req)) return json(res, 401, { erro: 'Esta rota exige o token do coletor.' });

  /* ================= PRODUTOS MONITORADOS ================= */
  if (rota === '/api/produtos' && metodo === 'POST') {
    const { nome, termo, categoria, preco_alvo } = await lerCorpo(req);
    const n = String(nome || '').trim();
    if (!n) return json(res, 400, { erro: 'Informe o nome do produto.' });
    const t = String(termo || '').trim() || n;
    const alvo = num(preco_alvo) || 0;
    if (!Number.isFinite(alvo) || alvo < 0) return json(res, 400, { erro: 'Preco alvo invalido.' });
    const agora = new Date().toISOString();
    const info = (await db.run('INSERT INTO produtos (user_id, nome, termo, categoria, preco_alvo, criado_em, atualizado_em) VALUES (?,?,?,?,?,?,?)', VITRINE.id, n, t, String(categoria || 'Outros'), alvo, agora, agora));
    return json(res, 201, await produtoPorId(VITRINE.id, Number(info.lastInsertRowid)));
  }

  let m = rota.match(/^\/api\/produtos\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const produto = (await db.get('SELECT * FROM produtos WHERE id = ? AND user_id = ?', id, VITRINE.id));
    if (!produto) return json(res, 404, { erro: 'Produto nao encontrado.' });

    if (metodo === 'PATCH') {
      const c = await lerCorpo(req);
      const alvo = c.preco_alvo === undefined ? produto.preco_alvo : num(c.preco_alvo);
      if (!Number.isFinite(alvo) || alvo < 0) return json(res, 400, { erro: 'Preco alvo invalido.' });
      (await db.run('UPDATE produtos SET nome = ?, termo = ?, categoria = ?, preco_alvo = ?, atualizado_em = ? WHERE id = ?', c.nome === undefined ? produto.nome : String(c.nome).trim() || produto.nome,
          c.termo === undefined ? produto.termo : String(c.termo).trim() || produto.termo,
          c.categoria === undefined ? produto.categoria : String(c.categoria),
          alvo,
          new Date().toISOString(),
          id));
      return json(res, 200, await produtoPorId(VITRINE.id, id));
    }

    if (metodo === 'DELETE') {
      (await db.run('DELETE FROM ofertas WHERE produto_id = ? AND user_id = ?', id, VITRINE.id));
      (await db.run('DELETE FROM coletas WHERE produto_id = ? AND user_id = ?', id, VITRINE.id));
      (await db.run('DELETE FROM produtos WHERE id = ?', id));
      return json(res, 200, { ok: true });
    }
  }

  /* ----- coleta de precos ----- */
  m = rota.match(/^\/api\/produtos\/(\d+)\/coletar$/);
  if (m && metodo === 'POST') {
    const id = Number(m[1]);
    const produto = (await db.get('SELECT * FROM produtos WHERE id = ? AND user_id = ?', id, VITRINE.id));
    if (!produto) return json(res, 404, { erro: 'Produto nao encontrado.' });
    const resultado = await coletarPrecos(VITRINE.id, produto);
    return json(res, 200, Object.assign(resultado, { detalhe: await detalheProduto(VITRINE.id, id) }));
  }

  /* ----- oferta lancada a mao (plano B e lojas sem API) ----- */
  m = rota.match(/^\/api\/produtos\/(\d+)\/ofertas$/);
  if (m && metodo === 'POST') {
    const id = Number(m[1]);
    const produto = (await db.get('SELECT * FROM produtos WHERE id = ? AND user_id = ?', id, VITRINE.id));
    if (!produto) return json(res, 404, { erro: 'Produto nao encontrado.' });

    const c = await lerCorpo(req);
    const loja = String(c.loja || '').trim();
    const preco = num(c.preco);
    const frete = num(c.frete) || 0;
    if (!loja) return json(res, 400, { erro: 'Informe a loja.' });
    if (!Number.isFinite(preco) || preco <= 0) return json(res, 400, { erro: 'Preco invalido.' });
    if (!Number.isFinite(frete) || frete < 0) return json(res, 400, { erro: 'Frete invalido.' });

    const agora = new Date().toISOString();
    const coleta = (await db.run("INSERT INTO coletas (produto_id, user_id, fonte, executado_em, encontrados, erro) VALUES (?,?,?,?,1,'')", id, VITRINE.id, loja, agora));

    (await db.run('INSERT INTO ofertas (coleta_id, produto_id, user_id, loja, titulo, preco, frete, preco_total, condicao, vendedor, reputacao, vendidos, parcelas, url, id_externo, manual, coletado_em) ' +
      "VALUES (?,?,?,?,?,?,?,?,?,'','',0,0,?,'',1,?)", Number(coleta.lastInsertRowid), id, VITRINE.id, loja, String(c.titulo || produto.nome),
      preco, frete, preco + frete, ['novo', 'usado'].indexOf(c.condicao) === -1 ? 'novo' : c.condicao,
      String(c.url || ''), agora));
    return json(res, 201, await detalheProduto(VITRINE.id, id));
  }

  m = rota.match(/^\/api\/ofertas\/(\d+)$/);
  if (m && metodo === 'DELETE') {
    const info = (await db.run('DELETE FROM ofertas WHERE id = ? AND user_id = ?', Number(m[1]), VITRINE.id));
    if (!info.changes) return json(res, 404, { erro: 'Oferta nao encontrada.' });
    return json(res, 200, { ok: true });
  }

  /* ----- busca avulsa, sem salvar ----- */
  if (rota === '/api/buscar' && metodo === 'POST') {
    const { termo } = await lerCorpo(req);
    const t = String(termo || '').trim();
    if (!t) return json(res, 400, { erro: 'Informe o que voce quer buscar.' });
    const pesquisa = await ia.pesquisar(t);
    return json(res, 200, { termo: t, fontes: pesquisa.fontes, comparacao: pesquisa.comparacao });
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
  // o separador evita que uma pasta irma chamada "public-algo" passe no teste
  if (destino !== PUBLICO && destino.indexOf(PUBLICO + path.sep) !== 0) {
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

/* o banco precisa estar pronto (tabelas criadas e vitrine existente) antes de
   atender qualquer pedido */
(async () => {
  await db.iniciar();
  await garantirVitrine();
  servidor.listen(PORTA, ENDERECO, () => {
    console.log('\n  Comparador de Precos rodando em  http://localhost:' + PORTA + '\n  (Ctrl+C para parar)\n');
  });
})().catch((e) => {
  console.error('\n  Nao consegui preparar o banco: ' + e.message + '\n');
  process.exit(1);
});
