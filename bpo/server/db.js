'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Valores em centavos (inteiros). Datas de negócio em 'AAAA-MM-DD'; carimbos de criação em UTC.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','supervisor','analista')),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Carteira: empresas atendidas pelo BPO.
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT,
  cnpj TEXT NOT NULL UNIQUE,
  email TEXT,
  telefone TEXT,
  responsavel TEXT,
  analista_id INTEGER REFERENCES usuarios(id),
  plano TEXT NOT NULL DEFAULT 'essencial' CHECK (plano IN ('essencial','completo','premium')),
  mensalidade_centavos INTEGER NOT NULL DEFAULT 0 CHECK (mensalidade_centavos >= 0),
  dia_vencimento INTEGER NOT NULL DEFAULT 10 CHECK (dia_vencimento BETWEEN 1 AND 28),
  inicio_contrato TEXT NOT NULL,
  fim_contrato TEXT,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('implantacao','ativa','suspensa','encerrada')),
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_empresas_analista ON empresas(analista_id);

CREATE TABLE IF NOT EXISTS tarefas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  titulo TEXT NOT NULL,
  descricao TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  vencimento TEXT NOT NULL,
  recorrencia TEXT NOT NULL DEFAULT 'nenhuma' CHECK (recorrencia IN ('nenhuma','semanal','mensal')),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','concluida','cancelada')),
  concluida_em TEXT,
  concluida_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tarefas_empresa ON tarefas(empresa_id, status, vencimento);

-- Plano de contas da empresa. grupo_dre define a linha da DRE.
CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('receita','despesa')),
  grupo_dre TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  UNIQUE (empresa_id, nome)
);

CREATE TABLE IF NOT EXISTS centros_custo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  UNIQUE (empresa_id, nome)
);

-- Fornecedores e clientes da empresa atendida.
CREATE TABLE IF NOT EXISTS contatos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('fornecedor','cliente','ambos')),
  nome TEXT NOT NULL,
  documento TEXT,
  email TEXT,
  telefone TEXT,
  chave_pix TEXT,
  observacoes TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contatos_empresa ON contatos(empresa_id);

CREATE TABLE IF NOT EXISTS contas_bancarias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  descricao TEXT NOT NULL,
  banco TEXT NOT NULL,
  agencia TEXT,
  numero TEXT,
  saldo_inicial_centavos INTEGER NOT NULL DEFAULT 0,
  data_saldo_inicial TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Contas a pagar e a receber. Uma compra parcelada gera um lançamento por parcela (mesmo grupo).
CREATE TABLE IF NOT EXISTS lancamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('pagar','receber')),
  descricao TEXT NOT NULL,
  contato_id INTEGER REFERENCES contatos(id),
  categoria_id INTEGER REFERENCES categorias(id),
  centro_custo_id INTEGER REFERENCES centros_custo(id),
  conta_bancaria_id INTEGER REFERENCES contas_bancarias(id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  competencia TEXT NOT NULL,
  vencimento TEXT NOT NULL,
  documento TEXT,
  parcela INTEGER NOT NULL DEFAULT 1,
  total_parcelas INTEGER NOT NULL DEFAULT 1,
  grupo TEXT,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','pago','cancelado')),
  pago_em TEXT,
  valor_pago_centavos INTEGER,
  juros_centavos INTEGER NOT NULL DEFAULT 0,
  desconto_centavos INTEGER NOT NULL DEFAULT 0,
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lanc_empresa ON lancamentos(empresa_id, tipo, status, vencimento);
CREATE INDEX IF NOT EXISTS idx_lanc_competencia ON lancamentos(empresa_id, competencia);
CREATE INDEX IF NOT EXISTS idx_lanc_grupo ON lancamentos(grupo);

-- Livro caixa de cada conta bancária: baixas, transferências e ajustes. Valor com sinal (+ entrada, - saída).
CREATE TABLE IF NOT EXISTS movimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conta_bancaria_id INTEGER NOT NULL REFERENCES contas_bancarias(id),
  data TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos <> 0),
  descricao TEXT NOT NULL,
  origem TEXT NOT NULL CHECK (origem IN ('baixa','transferencia','ajuste')),
  lancamento_id INTEGER REFERENCES lancamentos(id),
  grupo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mov_conta ON movimentos(conta_bancaria_id, data);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mov_lancamento ON movimentos(lancamento_id) WHERE lancamento_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conta_bancaria_id INTEGER NOT NULL REFERENCES contas_bancarias(id),
  arquivo TEXT,
  formato TEXT NOT NULL,
  itens INTEGER NOT NULL,
  duplicados INTEGER NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Linhas do extrato importado. Cada uma é conciliada com um movimento do livro caixa ou ignorada.
CREATE TABLE IF NOT EXISTS extrato (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conta_bancaria_id INTEGER NOT NULL REFERENCES contas_bancarias(id),
  importacao_id INTEGER REFERENCES importacoes(id),
  data TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  descricao TEXT,
  documento TEXT,
  fitid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','conciliado','ignorado')),
  movimento_id INTEGER UNIQUE REFERENCES movimentos(id),
  conciliado_por INTEGER REFERENCES usuarios(id),
  conciliado_em TEXT,
  UNIQUE (conta_bancaria_id, fitid)
);
CREATE INDEX IF NOT EXISTS idx_extrato_conta ON extrato(conta_bancaria_id, status, data);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  empresa_id INTEGER REFERENCES empresas(id),
  acao TEXT NOT NULL,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auditoria_data ON auditoria(criado_em);
`;

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (arquivo !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  garantirAdmin(db);
  return db;
}

function garantirAdmin(db) {
  const existe = db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'admin' LIMIT 1").get();
  if (existe) return;
  const { nome, email, senha } = config.admin;
  db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)').run(nome, email, hashSenha(senha), 'admin');
}

const abertas = new WeakSet();

/** Executa fn dentro de uma transação (BEGIN IMMEDIATE … COMMIT). Chamadas aninhadas usam a transação de fora. */
function transacao(db, fn) {
  if (abertas.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  abertas.add(db);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    abertas.delete(db);
  }
}

module.exports = { abrir, transacao };
