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
const coletores = [require('./coletores/mercadolivre.js')];
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
function listarProdutos(userId) {
  const produtos = db.prepare('SELECT * FROM produtos WHERE user_id = ? ORDER BY nome').all(userId);
  return produtos.map((p) => {
    const melhor = db.prepare(
      'SELECT loja, preco_total, coletado_em FROM ofertas WHERE produto_id = ? ' +
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

/* ---------- rotas ---------- */
async function api(req, res, rota) {
  const metodo = req.method;

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

  if (!usuario) return json(res, 401, { erro: 'Nao autenticado.' });

  if (rota === '/api/eu' && metodo === 'GET') {
    return json(res, 200, { nome: usuario.nome, email: usuario.email, admin: usuario.admin });
  }

  /* ================= PRODUTOS MONITORADOS ================= */
  if (rota === '/api/fontes' && metodo === 'GET') {
    return json(res, 200, coletores.map((c) => ({ chave: c.chave, nome: c.nome, configurado: c.configurado() })));
  }

  if (rota === '/api/produtos' && metodo === 'GET') {
    return json(res, 200, listarProdutos(usuario.id));
  }

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

    if (metodo === 'GET') return json(res, 200, detalheProduto(usuario.id, id));

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
