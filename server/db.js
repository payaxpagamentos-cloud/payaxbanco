'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','gerente','operador')),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('PF','PJ')),
  nome TEXT NOT NULL,
  documento TEXT NOT NULL UNIQUE,
  email TEXT,
  telefone TEXT,
  data_nascimento TEXT,
  renda_mensal_centavos INTEGER NOT NULL DEFAULT 0,
  cep TEXT, logradouro TEXT, numero TEXT, complemento TEXT,
  bairro TEXT, cidade TEXT, uf TEXT,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo','bloqueado')),
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('corrente','poupanca','pagamento','salario')),
  agencia TEXT NOT NULL,
  numero TEXT NOT NULL,
  digito TEXT NOT NULL,
  saldo_centavos INTEGER NOT NULL DEFAULT 0,
  limite_centavos INTEGER NOT NULL DEFAULT 0 CHECK (limite_centavos >= 0),
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','bloqueada','encerrada')),
  aberta_em TEXT NOT NULL DEFAULT (datetime('now')),
  encerrada_em TEXT,
  UNIQUE (agencia, numero)
);
CREATE INDEX IF NOT EXISTS idx_contas_cliente ON contas(cliente_id);

CREATE TABLE IF NOT EXISTS transacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id),
  tipo TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  saldo_apos_centavos INTEGER NOT NULL,
  descricao TEXT,
  contraparte_conta_id INTEGER REFERENCES contas(id),
  grupo TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  estornada_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transacoes_conta ON transacoes(conta_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_transacoes_grupo ON transacoes(grupo);
CREATE INDEX IF NOT EXISTS idx_transacoes_data ON transacoes(criado_em);

CREATE TABLE IF NOT EXISTS chaves_pix (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('cpf','cnpj','email','telefone','aleatoria')),
  chave TEXT NOT NULL UNIQUE,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emprestimos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  valor_centavos INTEGER NOT NULL,
  taxa_mensal REAL NOT NULL,
  num_parcelas INTEGER NOT NULL,
  valor_parcela_centavos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','quitado','cancelado')),
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parcelas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emprestimo_id INTEGER NOT NULL REFERENCES emprestimos(id),
  numero INTEGER NOT NULL,
  vencimento TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga')),
  paga_em TEXT,
  UNIQUE (emprestimo_id, numero)
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id INTEGER,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auditoria_data ON auditoria(criado_em);
`;

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON;');
  if (arquivo !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  garantirAdmin(db);
  return db;
}

function garantirAdmin(db) {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM usuarios').get();
  if (total > 0) return;
  db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)')
    .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), 'admin');
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[PAY AX] Usuário administrador criado: ${config.admin.email} (altere a senha no primeiro acesso).`);
  }
}

/** Executa fn dentro de uma transação SQLite (BEGIN IMMEDIATE / COMMIT / ROLLBACK). */
function transacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { abrir, transacao };
