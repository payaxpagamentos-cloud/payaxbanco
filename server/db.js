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

-- Integração Bradesco: cobranças PIX geradas para crédito em conta de cliente.
CREATE TABLE IF NOT EXISTS cobrancas_pix (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id),
  txid TEXT NOT NULL UNIQUE,
  valor_centavos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','concluida','expirada','cancelada')),
  pix_copia_e_cola TEXT,
  expira_em TEXT NOT NULL,
  end_to_end_id TEXT,
  pago_em TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cobrancas_conta ON cobrancas_pix(conta_id);

-- PIX que entraram na conta PAY AX no Bradesco (idempotente por endToEndId).
CREATE TABLE IF NOT EXISTS pix_recebidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  end_to_end_id TEXT NOT NULL UNIQUE,
  txid TEXT,
  valor_centavos INTEGER NOT NULL,
  pagador_nome TEXT,
  pagador_documento TEXT,
  info_pagador TEXT,
  conta_id INTEGER REFERENCES contas(id),
  transacao_id INTEGER REFERENCES transacoes(id),
  status TEXT NOT NULL CHECK (status IN ('creditado','sem_vinculo')),
  motivo TEXT,
  recebido_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- PIX enviados da conta PAY AX no Bradesco para outros bancos, a pedido de clientes.
CREATE TABLE IF NOT EXISTS pix_saidas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id),
  transacao_id INTEGER REFERENCES transacoes(id),
  valor_centavos INTEGER NOT NULL,
  chave TEXT NOT NULL,
  descricao TEXT,
  idempotencia TEXT NOT NULL UNIQUE,
  end_to_end_id TEXT,
  status TEXT NOT NULL DEFAULT 'processando' CHECK (status IN ('processando','concluido','falhou')),
  erro TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Internet Banking: credenciais do cliente (separadas dos usuários da equipe).
CREATE TABLE IF NOT EXISTS acessos_cliente (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL UNIQUE REFERENCES clientes(id),
  senha_hash TEXT NOT NULL,
  pin_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','bloqueado')),
  precisa_trocar_senha INTEGER NOT NULL DEFAULT 1,
  tentativas INTEGER NOT NULL DEFAULT 0,
  tentativas_pin INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate TEXT,
  limite_diario_centavos INTEGER NOT NULL DEFAULT 500000,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Propostas de abertura de conta feitas pelo site (analisadas pela equipe).
CREATE TABLE IF NOT EXISTS propostas_conta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocolo TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL CHECK (tipo IN ('PF','PJ')),
  documento TEXT NOT NULL,
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  telefone TEXT NOT NULL,
  tipo_conta TEXT NOT NULL CHECK (tipo_conta IN ('corrente','pagamento')),
  dados TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'em_analise' CHECK (status IN ('em_analise','aprovada','recusada')),
  motivo TEXT,
  cliente_id INTEGER REFERENCES clientes(id),
  conta_id INTEGER REFERENCES contas(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  analisado_em TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_propostas_status ON propostas_conta(status, criado_em);

-- Favorecidos do cliente (cadastrados pela equipe; o cliente usa no PIX e na transferência).
CREATE TABLE IF NOT EXISTS favorecidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('pix','conta')),
  apelido TEXT,
  nome TEXT,
  documento TEXT,
  chave TEXT,
  conta_id INTEGER REFERENCES contas(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_favorecidos_cliente ON favorecidos(cliente_id);

-- Desafios do teclado virtual de pares (uso único, expiram em 3 minutos).
CREATE TABLE IF NOT EXISTS desafios_teclado (
  id TEXT PRIMARY KEY,
  teclas TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  usado INTEGER NOT NULL DEFAULT 0
);

-- Pagamentos de boletos e contas de consumo, liquidados pela conta PAY AX no Bradesco.
CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id),
  transacao_id INTEGER REFERENCES transacoes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('boleto','convenio')),
  codigo_barras TEXT NOT NULL,
  linha_digitavel TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  vencimento TEXT,
  idempotencia TEXT NOT NULL UNIQUE,
  autenticacao TEXT,
  status TEXT NOT NULL DEFAULT 'processando' CHECK (status IN ('processando','concluido','falhou')),
  erro TEXT,
  canal TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Estado do simulador do Bradesco (usado quando BRADESCO_MODO=simulador).
CREATE TABLE IF NOT EXISTS bradesco_sim_movimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  natureza TEXT NOT NULL CHECK (natureza IN ('C','D')),
  valor_centavos INTEGER NOT NULL,
  descricao TEXT,
  end_to_end_id TEXT,
  txid TEXT,
  pagador_nome TEXT,
  pagador_documento TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bradesco_sim_cobrancas (
  txid TEXT PRIMARY KEY,
  valor_centavos INTEGER NOT NULL,
  status TEXT NOT NULL,
  pix_copia_e_cola TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON;');
  if (arquivo !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrar(db);
  garantirAdmin(db);
  return db;
}

/** Colunas adicionadas depois da primeira versão (bancos existentes recebem ALTER TABLE). */
const COLUNAS = [
  ['transacoes', 'canal', "TEXT NOT NULL DEFAULT 'agencia'"],
  ['auditoria', 'cliente_id', 'INTEGER REFERENCES clientes(id)'],
];

function migrar(db) {
  for (const [tabela, coluna, tipo] of COLUNAS) {
    const existe = db.prepare(`SELECT 1 FROM pragma_table_info('${tabela}') WHERE name = ?`).get(coluna);
    if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
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
