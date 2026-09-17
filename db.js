'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

// Em producao (Render) aponte DB_PATH para um disco persistente, ex.: /var/data/investimentos.db
const CAMINHO = process.env.DB_PATH || path.join(__dirname, 'investimentos.db');
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

CREATE TABLE IF NOT EXISTS ativos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  ticker       TEXT NOT NULL,
  nome         TEXT NOT NULL DEFAULT '',
  classe       TEXT NOT NULL,
  preco_atual  REAL NOT NULL DEFAULT 0,
  atualizado_em TEXT NOT NULL,
  UNIQUE (user_id, ticker)
);

CREATE TABLE IF NOT EXISTS transacoes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  ativo_id   INTEGER NOT NULL REFERENCES ativos(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL CHECK (tipo IN ('compra','venda','provento')),
  quantidade REAL NOT NULL,
  preco      REAL NOT NULL,
  taxas      REAL NOT NULL DEFAULT 0,
  data       TEXT NOT NULL,
  obs        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tx_user ON transacoes(user_id, data);

CREATE TABLE IF NOT EXISTS telas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  descricao     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','oficial')),
  inicial       INTEGER NOT NULL DEFAULT 0,
  ordem         INTEGER NOT NULL DEFAULT 0,
  config        TEXT NOT NULL DEFAULT '{"blocos":[]}',
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telas_user ON telas(user_id, ordem);
`);

// Coluna de administrador (adicionada depois; ALTER seguro para bancos antigos)
const colunas = db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name);
if (colunas.indexOf('admin') === -1) {
  db.exec('ALTER TABLE usuarios ADD COLUMN admin INTEGER NOT NULL DEFAULT 0');
}

module.exports = db;
