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

/* ---------- calculo da carteira ---------- */
function calcularCarteira(userId) {
  const ativos = db.prepare('SELECT * FROM ativos WHERE user_id = ? ORDER BY ticker').all(userId);
  const txs = db.prepare('SELECT * FROM transacoes WHERE user_id = ? ORDER BY data, id').all(userId);

  const posicoes = ativos.map((a) => {
    let qtd = 0, custo = 0, realizado = 0, proventos = 0;
    for (const t of txs) {
      if (t.ativo_id !== a.id) continue;
      if (t.tipo === 'compra') {
        qtd += t.quantidade;
        custo += t.quantidade * t.preco + t.taxas;
      } else if (t.tipo === 'venda') {
        const pm = qtd > 0 ? custo / qtd : 0;
        const q = Math.min(t.quantidade, qtd);
        realizado += q * t.preco - t.taxas - q * pm;
        qtd -= q;
        custo -= q * pm;
        if (qtd <= 1e-9) { qtd = 0; custo = 0; }
      } else {
        proventos += t.preco;
      }
    }
    const preco_medio = qtd > 0 ? custo / qtd : 0;
    const valor_atual = qtd * a.preco_atual;
    const lucro = valor_atual - custo;
    return {
      id: a.id,
      ticker: a.ticker,
      nome: a.nome,
      classe: a.classe,
      preco_atual: a.preco_atual,
      atualizado_em: a.atualizado_em,
      quantidade: qtd,
      custo,
      preco_medio,
      valor_atual,
      lucro,
      rentabilidade: custo > 0 ? (lucro / custo) * 100 : 0,
      realizado,
      proventos,
    };
  });

  const totais = posicoes.reduce(
    (acc, p) => ({
      investido: acc.investido + p.custo,
      patrimonio: acc.patrimonio + p.valor_atual,
      lucro: acc.lucro + p.lucro,
      realizado: acc.realizado + p.realizado,
      proventos: acc.proventos + p.proventos,
    }),
    { investido: 0, patrimonio: 0, lucro: 0, realizado: 0, proventos: 0 }
  );
  totais.rentabilidade = totais.investido > 0 ? (totais.lucro / totais.investido) * 100 : 0;

  const porClasse = {};
  for (const p of posicoes) {
    if (p.valor_atual <= 0) continue;
    porClasse[p.classe] = (porClasse[p.classe] || 0) + p.valor_atual;
  }
  const alocacao = Object.entries(porClasse)
    .map(([classe, valor]) => ({
      classe,
      valor,
      pct: totais.patrimonio > 0 ? (valor / totais.patrimonio) * 100 : 0,
    }))
    .sort((a, b) => b.valor - a.valor);

  return { posicoes, totais, alocacao };
}

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

/* ---------- telas do laboratorio ---------- */
const TIPOS_BLOCO = ['kpi', 'rosca', 'barras', 'tabela', 'lancamentos', 'texto', 'metas', 'livre'];
const MAX_BLOCOS = 40;
const MAX_CONFIG = 400000; // ~400 KB por tela

function validarConfig(config) {
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { throw new Error('Configuracao da tela invalida.'); }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Configuracao da tela invalida.');
  const blocos = Array.isArray(config.blocos) ? config.blocos : [];
  if (blocos.length > MAX_BLOCOS) throw new Error('Limite de ' + MAX_BLOCOS + ' blocos por tela.');
  const limpos = blocos.map((b, i) => {
    if (!b || typeof b !== 'object') throw new Error('Bloco ' + (i + 1) + ' invalido.');
    if (TIPOS_BLOCO.indexOf(b.tipo) === -1) throw new Error('Tipo de bloco desconhecido: ' + b.tipo);
    return {
      id: String(b.id || 'b' + Date.now() + i),
      tipo: b.tipo,
      titulo: String(b.titulo || ''),
      tamanho: ['p', 'm', 'g'].indexOf(b.tamanho) === -1 ? 'm' : b.tamanho,
      opcoes: b.opcoes && typeof b.opcoes === 'object' && !Array.isArray(b.opcoes) ? b.opcoes : {},
    };
  });
  const saida = { blocos: limpos };
  const texto = JSON.stringify(saida);
  if (texto.length > MAX_CONFIG) throw new Error('Tela grande demais para salvar.');
  return saida;
}

function formatarTela(linha) {
  let config;
  try { config = JSON.parse(linha.config); } catch { config = { blocos: [] }; }
  return {
    id: linha.id,
    nome: linha.nome,
    descricao: linha.descricao,
    status: linha.status,
    inicial: !!linha.inicial,
    ordem: linha.ordem,
    config,
    criado_em: linha.criado_em,
    atualizado_em: linha.atualizado_em,
  };
}
function listarTelas(userId) {
  return db.prepare('SELECT * FROM telas WHERE user_id = ? ORDER BY ordem, id').all(userId).map(formatarTela);
}
function telaPorId(userId, id) {
  const linha = db.prepare('SELECT * FROM telas WHERE id = ? AND user_id = ?').get(id, userId);
  return linha ? formatarTela(linha) : null;
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

  if (rota === '/api/carteira' && metodo === 'GET') {
    return json(res, 200, calcularCarteira(usuario.id));
  }

  if (rota === '/api/ativos' && metodo === 'POST') {
    const { ticker, nome, classe, preco_atual } = await lerCorpo(req);
    const t = String(ticker || '').trim().toUpperCase();
    if (!t) return json(res, 400, { erro: 'Informe o ticker do ativo.' });
    if (!classe) return json(res, 400, { erro: 'Informe a classe do ativo.' });
    const preco = num(preco_atual) || 0;
    if (!Number.isFinite(preco) || preco < 0) return json(res, 400, { erro: 'Preco atual invalido.' });
    if (db.prepare('SELECT id FROM ativos WHERE user_id = ? AND ticker = ?').get(usuario.id, t)) {
      return json(res, 409, { erro: 'O ativo ' + t + ' ja existe na sua carteira.' });
    }
    db.prepare('INSERT INTO ativos (user_id, ticker, nome, classe, preco_atual, atualizado_em) VALUES (?,?,?,?,?,?)')
      .run(usuario.id, t, String(nome || ''), String(classe), preco, new Date().toISOString());
    return json(res, 201, { ok: true });
  }

  let m = rota.match(/^\/api\/ativos\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const ativo = db.prepare('SELECT * FROM ativos WHERE id = ? AND user_id = ?').get(id, usuario.id);
    if (!ativo) return json(res, 404, { erro: 'Ativo nao encontrado.' });

    if (metodo === 'PATCH') {
      const corpo = await lerCorpo(req);
      const preco = corpo.preco_atual === undefined ? ativo.preco_atual : num(corpo.preco_atual);
      if (!Number.isFinite(preco) || preco < 0) return json(res, 400, { erro: 'Preco atual invalido.' });
      db.prepare('UPDATE ativos SET preco_atual = ?, nome = ?, classe = ?, atualizado_em = ? WHERE id = ?')
        .run(
          preco,
          corpo.nome === undefined ? ativo.nome : String(corpo.nome),
          corpo.classe === undefined ? ativo.classe : String(corpo.classe),
          new Date().toISOString(),
          id
        );
      return json(res, 200, { ok: true });
    }
    if (metodo === 'DELETE') {
      db.prepare('DELETE FROM transacoes WHERE ativo_id = ? AND user_id = ?').run(id, usuario.id);
      db.prepare('DELETE FROM ativos WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  if (rota === '/api/transacoes' && metodo === 'GET') {
    const linhas = db.prepare(
      'SELECT t.*, a.ticker FROM transacoes t JOIN ativos a ON a.id = t.ativo_id ' +
      'WHERE t.user_id = ? ORDER BY t.data DESC, t.id DESC LIMIT 300'
    ).all(usuario.id);
    return json(res, 200, linhas);
  }

  if (rota === '/api/transacoes' && metodo === 'POST') {
    const { ativo_id, tipo, quantidade, preco, taxas, data, obs } = await lerCorpo(req);
    if (['compra', 'venda', 'provento'].indexOf(tipo) === -1) return json(res, 400, { erro: 'Tipo de lancamento invalido.' });
    const ativo = db.prepare('SELECT id FROM ativos WHERE id = ? AND user_id = ?').get(Number(ativo_id), usuario.id);
    if (!ativo) return json(res, 400, { erro: 'Selecione um ativo da sua carteira.' });
    const q = tipo === 'provento' ? 0 : num(quantidade);
    const p = num(preco);
    const tx = num(taxas) || 0;
    if (tipo !== 'provento' && (!Number.isFinite(q) || q <= 0)) return json(res, 400, { erro: 'Quantidade invalida.' });
    if (!Number.isFinite(p) || p < 0) return json(res, 400, { erro: tipo === 'provento' ? 'Valor recebido invalido.' : 'Preco invalido.' });
    if (!Number.isFinite(tx) || tx < 0) return json(res, 400, { erro: 'Taxas invalidas.' });
    const dataISO = /^\d{4}-\d{2}-\d{2}$/.test(String(data || '')) ? data : new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO transacoes (user_id, ativo_id, tipo, quantidade, preco, taxas, data, obs) VALUES (?,?,?,?,?,?,?,?)')
      .run(usuario.id, ativo.id, tipo, q, p, tx, dataISO, String(obs || ''));
    return json(res, 201, { ok: true });
  }

  /* ----- telas do laboratorio ----- */
  if (rota === '/api/telas' && metodo === 'GET') {
    return json(res, 200, listarTelas(usuario.id));
  }

  if (rota === '/api/telas' && metodo === 'POST') {
    const corpo = await lerCorpo(req);
    const nome = String(corpo.nome || '').trim() || 'Nova tela';
    const agora = new Date().toISOString();
    const maxOrdem = db.prepare('SELECT COALESCE(MAX(ordem), 0) AS m FROM telas WHERE user_id = ?').get(usuario.id).m;
    let config;
    try {
      config = validarConfig(corpo.config === undefined ? { blocos: [] } : corpo.config);
    } catch (e) {
      return json(res, 400, { erro: e.message });
    }
    const info = db.prepare(
      'INSERT INTO telas (user_id, nome, descricao, status, inicial, ordem, config, criado_em, atualizado_em) ' +
      "VALUES (?,?,?,'rascunho',0,?,?,?,?)"
    ).run(usuario.id, nome, String(corpo.descricao || ''), maxOrdem + 1, JSON.stringify(config), agora, agora);
    return json(res, 201, telaPorId(usuario.id, Number(info.lastInsertRowid)));
  }

  m = rota.match(/^\/api\/telas\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const tela = db.prepare('SELECT * FROM telas WHERE id = ? AND user_id = ?').get(id, usuario.id);
    if (!tela) return json(res, 404, { erro: 'Tela nao encontrada.' });

    if (metodo === 'GET') return json(res, 200, telaPorId(usuario.id, id));

    if (metodo === 'PATCH') {
      const corpo = await lerCorpo(req);
      let config = tela.config;
      if (corpo.config !== undefined) {
        try {
          config = JSON.stringify(validarConfig(corpo.config));
        } catch (e) {
          return json(res, 400, { erro: e.message });
        }
      }
      const nome = corpo.nome === undefined ? tela.nome : String(corpo.nome).trim() || tela.nome;
      const descricao = corpo.descricao === undefined ? tela.descricao : String(corpo.descricao);
      const status = corpo.status === undefined ? tela.status : String(corpo.status);
      if (['rascunho', 'oficial'].indexOf(status) === -1) return json(res, 400, { erro: 'Status invalido.' });
      const ordem = corpo.ordem === undefined ? tela.ordem : Number(corpo.ordem) || 0;
      let inicial = corpo.inicial === undefined ? tela.inicial : corpo.inicial ? 1 : 0;
      if (status !== 'oficial') inicial = 0;

      if (inicial) db.prepare('UPDATE telas SET inicial = 0 WHERE user_id = ?').run(usuario.id);
      db.prepare(
        'UPDATE telas SET nome = ?, descricao = ?, status = ?, inicial = ?, ordem = ?, config = ?, atualizado_em = ? WHERE id = ?'
      ).run(nome, descricao, status, inicial, ordem, config, new Date().toISOString(), id);
      return json(res, 200, telaPorId(usuario.id, id));
    }

    if (metodo === 'DELETE') {
      db.prepare('DELETE FROM telas WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  m = rota.match(/^\/api\/telas\/(\d+)\/duplicar$/);
  if (m && metodo === 'POST') {
    const tela = db.prepare('SELECT * FROM telas WHERE id = ? AND user_id = ?').get(Number(m[1]), usuario.id);
    if (!tela) return json(res, 404, { erro: 'Tela nao encontrada.' });
    const agora = new Date().toISOString();
    const maxOrdem = db.prepare('SELECT COALESCE(MAX(ordem), 0) AS m FROM telas WHERE user_id = ?').get(usuario.id).m;
    const info = db.prepare(
      'INSERT INTO telas (user_id, nome, descricao, status, inicial, ordem, config, criado_em, atualizado_em) ' +
      "VALUES (?,?,?,'rascunho',0,?,?,?,?)"
    ).run(usuario.id, tela.nome + ' (cópia)', tela.descricao, maxOrdem + 1, tela.config, agora, agora);
    return json(res, 201, telaPorId(usuario.id, Number(info.lastInsertRowid)));
  }

  m = rota.match(/^\/api\/transacoes\/(\d+)$/);
  if (m && metodo === 'DELETE') {
    const info = db.prepare('DELETE FROM transacoes WHERE id = ? AND user_id = ?').run(Number(m[1]), usuario.id);
    if (!info.changes) return json(res, 404, { erro: 'Lancamento nao encontrado.' });
    return json(res, 200, { ok: true });
  }

  /* ----- area do administrador ----- */
  if (rota.indexOf('/api/admin/') === 0) {
    if (!usuario.admin) return json(res, 403, { erro: 'Acesso restrito ao administrador.' });

    if (rota === '/api/admin/usuarios' && metodo === 'GET') {
      const linhas = db.prepare(
        'SELECT u.id, u.nome, u.email, u.admin, u.criado_em, ' +
        '  (SELECT COUNT(*) FROM ativos a WHERE a.user_id = u.id) AS ativos, ' +
        '  (SELECT COUNT(*) FROM transacoes t WHERE t.user_id = u.id) AS lancamentos, ' +
        '  (SELECT COUNT(*) FROM telas te WHERE te.user_id = u.id) AS telas, ' +
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
      db.prepare('DELETE FROM transacoes WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM ativos WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM telas WHERE user_id = ?').run(id);
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
  console.log('\n  Meus Investimentos rodando em  http://localhost:' + PORTA + '\n  (Ctrl+C para parar)\n');
});
