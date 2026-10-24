'use strict';
/* Banco do sistema.
   -------------------------------------------------------------------------
   Com DATABASE_URL: Postgres no Supabase. Os dados sobrevivem a deploys e
   hibernacoes do Render.
   Sem DATABASE_URL: SQLite local (node:sqlite), para testar na sua maquina.

   As duas formas tem a mesma interface, e todas as chamadas sao assincronas:
     await db.get(sql, ...valores)  -> uma linha (ou undefined)
     await db.all(sql, ...valores)  -> lista de linhas
     await db.run(sql, ...valores)  -> { changes, lastInsertRowid }
     await db.iniciar()             -> cria as tabelas (chamar uma vez, no boot)

   Escreva os placeholders como "?" nos dois casos: no Postgres eles sao
   trocados por $1, $2... automaticamente. */

const path = require('node:path');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const USA_POSTGRES = DATABASE_URL !== '';

/* ---------- esquemas ---------- */
const ESQUEMA_SQLITE = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS usuarios (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  nome       TEXT NOT NULL,
  senha_hash TEXT NOT NULL DEFAULT '',
  salt       TEXT NOT NULL DEFAULT '',
  criado_em  TEXT NOT NULL,
  admin      INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE IF NOT EXISTS coletas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id   INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  fonte        TEXT NOT NULL,
  executado_em TEXT NOT NULL,
  encontrados  INTEGER NOT NULL DEFAULT 0,
  erro         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ofertas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  coleta_id    INTEGER REFERENCES coletas(id) ON DELETE CASCADE,
  produto_id   INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  loja         TEXT NOT NULL,
  titulo       TEXT NOT NULL DEFAULT '',
  preco        REAL NOT NULL,
  preco_de     REAL NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS ofertas_ia (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_produto_padronizado TEXT NOT NULL,
  nome_oferta_original    TEXT NOT NULL,
  nome_loja               TEXT NOT NULL,
  preco                   REAL NOT NULL,
  preco_referencia_base   REAL,
  variacao_vs_base        REAL,
  situacao_compra         TEXT NOT NULL,
  url_oferta              TEXT NOT NULL DEFAULT '',
  texto_busca             TEXT NOT NULL DEFAULT '',
  importado_em            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ofertas_ia_loja ON ofertas_ia(nome_loja);
CREATE INDEX IF NOT EXISTS idx_ofertas_ia_situacao ON ofertas_ia(situacao_compra);
`;

const ESQUEMA_POSTGRES = `
CREATE TABLE IF NOT EXISTS usuarios (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  nome       TEXT NOT NULL,
  senha_hash TEXT NOT NULL DEFAULT '',
  salt       TEXT NOT NULL DEFAULT '',
  criado_em  TEXT NOT NULL,
  admin      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS produtos (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  termo         TEXT NOT NULL,
  categoria     TEXT NOT NULL DEFAULT 'Outros',
  preco_alvo    DOUBLE PRECISION NOT NULL DEFAULT 0,
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coletas (
  id           BIGSERIAL PRIMARY KEY,
  produto_id   BIGINT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  fonte        TEXT NOT NULL,
  executado_em TEXT NOT NULL,
  encontrados  INTEGER NOT NULL DEFAULT 0,
  erro         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ofertas (
  id           BIGSERIAL PRIMARY KEY,
  coleta_id    BIGINT REFERENCES coletas(id) ON DELETE CASCADE,
  produto_id   BIGINT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  loja         TEXT NOT NULL,
  titulo       TEXT NOT NULL DEFAULT '',
  preco        DOUBLE PRECISION NOT NULL,
  preco_de     DOUBLE PRECISION NOT NULL DEFAULT 0,
  frete        DOUBLE PRECISION NOT NULL DEFAULT 0,
  preco_total  DOUBLE PRECISION NOT NULL,
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

CREATE TABLE IF NOT EXISTS buscas (
  id            BIGSERIAL PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS ofertas_ia (
  id                      BIGSERIAL PRIMARY KEY,
  nome_produto_padronizado TEXT NOT NULL,
  nome_oferta_original    TEXT NOT NULL,
  nome_loja               TEXT NOT NULL,
  preco                   DOUBLE PRECISION NOT NULL,
  preco_referencia_base   DOUBLE PRECISION,
  variacao_vs_base        DOUBLE PRECISION,
  situacao_compra         TEXT NOT NULL,
  url_oferta              TEXT NOT NULL DEFAULT '',
  texto_busca             TEXT NOT NULL DEFAULT '',
  importado_em            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ofertas_ia_loja ON ofertas_ia(nome_loja);
CREATE INDEX IF NOT EXISTS idx_ofertas_ia_situacao ON ofertas_ia(situacao_compra);
CREATE INDEX IF NOT EXISTS idx_ofertas_ia_texto ON ofertas_ia(texto_busca);
`;

/* ---------- backends ---------- */
let pool = null;     // Postgres
let lite = null;     // SQLite

/* Troca ? por $1, $2, ... Nenhuma das nossas consultas usa ? dentro de texto. */
function paraPostgres(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => '$' + (++n));
}

/* INSERT no Postgres nao devolve o id por padrao: pedimos explicitamente. */
function comRetornoDeId(sql) {
  return /^\s*insert/i.test(sql) && !/returning/i.test(sql) ? sql + ' RETURNING id' : sql;
}

async function iniciar() {
  if (USA_POSTGRES) {
    const { Pool, types } = require('pg');
    // COUNT(*) vem como bigint (texto por padrao) e AVG como numeric: viram numero
    types.setTypeParser(20, (v) => parseInt(v, 10));
    types.setTypeParser(1700, (v) => parseFloat(v));
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
    await pool.query(ESQUEMA_POSTGRES);
    console.log('  Banco: Supabase (Postgres)');
  } else {
    const { DatabaseSync } = require('node:sqlite');
    lite = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'precos.db'));
    lite.exec(ESQUEMA_SQLITE);
    // o SQLite local ja tem as colunas antigas? completa o que faltar
    const colunas = lite.prepare('PRAGMA table_info(ofertas)').all().map((c) => c.name);
    if (colunas.indexOf('preco_de') === -1) lite.exec('ALTER TABLE ofertas ADD COLUMN preco_de REAL NOT NULL DEFAULT 0');
    console.log('  Banco: SQLite local (defina DATABASE_URL para usar o Supabase)');
  }
}

async function get(sql, ...valores) {
  if (pool) {
    const r = await pool.query(paraPostgres(sql), valores);
    return r.rows[0];
  }
  return lite.prepare(sql).get(...valores);
}

async function all(sql, ...valores) {
  if (pool) {
    const r = await pool.query(paraPostgres(sql), valores);
    return r.rows;
  }
  return lite.prepare(sql).all(...valores);
}

async function run(sql, ...valores) {
  if (pool) {
    const r = await pool.query(paraPostgres(comRetornoDeId(sql)), valores);
    const linha = r.rows[0] || {};
    return { changes: r.rowCount, lastInsertRowid: linha.id !== undefined ? linha.id : 0 };
  }
  const r = lite.prepare(sql).run(...valores);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

async function fechar() {
  if (pool) await pool.end();
  if (lite) lite.close();
}

module.exports = { iniciar, get, all, run, fechar, usaPostgres: () => USA_POSTGRES };
