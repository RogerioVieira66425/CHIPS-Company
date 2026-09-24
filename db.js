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

// O sistema nao tem mais login: a tabela de sessoes sai dos bancos antigos
db.exec('DROP TABLE IF EXISTS sessoes');

// Preco "de" (riscado na loja), acrescentado depois
const colunasOfertas = db.prepare('PRAGMA table_info(ofertas)').all().map((c) => c.name);
if (colunasOfertas.indexOf('preco_de') === -1) {
  db.exec('ALTER TABLE ofertas ADD COLUMN preco_de REAL NOT NULL DEFAULT 0');
}

// Coluna de administrador (adicionada depois; ALTER seguro para bancos antigos)
const colunas = db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name);
if (colunas.indexOf('admin') === -1) {
  db.exec('ALTER TABLE usuarios ADD COLUMN admin INTEGER NOT NULL DEFAULT 0');
}

module.exports = db;
