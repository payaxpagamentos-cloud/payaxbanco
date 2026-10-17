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

// Módulos adicionados depois da primeira versão: tabelas novas e colunas novas em tabelas existentes.
const SCHEMA_V2 = `
-- Responsáveis na empresa cliente. Com senha, acessam o Portal do Cliente.
CREATE TABLE IF NOT EXISTS responsaveis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  cargo TEXT,
  email TEXT,
  telefone TEXT,
  recebe_relatorios INTEGER NOT NULL DEFAULT 1,
  acesso_portal INTEGER NOT NULL DEFAULT 0,
  senha_hash TEXT,
  precisa_trocar_senha INTEGER NOT NULL DEFAULT 1,
  pode_aprovar INTEGER NOT NULL DEFAULT 0,
  limite_aprovacao_centavos INTEGER NOT NULL DEFAULT -1, -- -1 = sem limite
  totp_segredo TEXT,
  totp_ativo INTEGER NOT NULL DEFAULT 0,
  totp_ultimo_passo INTEGER,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_responsaveis_portal ON responsaveis(email COLLATE NOCASE) WHERE acesso_portal = 1;

-- Rateio de um lançamento entre centros de custo (percentual em centésimos de ponto: 10000 = 100%).
CREATE TABLE IF NOT EXISTS rateios (
  lancamento_id INTEGER NOT NULL REFERENCES lancamentos(id) ON DELETE CASCADE,
  centro_custo_id INTEGER NOT NULL REFERENCES centros_custo(id),
  percentual INTEGER NOT NULL CHECK (percentual > 0 AND percentual <= 10000),
  PRIMARY KEY (lancamento_id, centro_custo_id)
);

-- Histórico do fluxo de aprovação de pagamentos.
CREATE TABLE IF NOT EXISTS aprovacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lancamento_id INTEGER NOT NULL REFERENCES lancamentos(id),
  etapa TEXT NOT NULL CHECK (etapa IN ('solicitado','conferido','aprovado','recusado','reaberto')),
  usuario_id INTEGER REFERENCES usuarios(id),
  responsavel_id INTEGER REFERENCES responsaveis(id),
  comentario TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_aprovacoes_lanc ON aprovacoes(lancamento_id);

-- Cobrança: contatos feitos, promessas de pagamento e acordos (renegociações).
CREATE TABLE IF NOT EXISTS cobranca_registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  contato_id INTEGER NOT NULL REFERENCES contatos(id),
  lancamento_id INTEGER REFERENCES lancamentos(id),
  canal TEXT NOT NULL CHECK (canal IN ('lembrete','ligacao','email','whatsapp','visita','outro')),
  descricao TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cobranca_contato ON cobranca_registros(contato_id, criado_em);

CREATE TABLE IF NOT EXISTS promessas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  contato_id INTEGER NOT NULL REFERENCES contatos(id),
  lancamento_id INTEGER REFERENCES lancamentos(id),
  data_prometida TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','cumprida','quebrada')),
  observacao TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  resolvida_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS acordos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  contato_id INTEGER NOT NULL REFERENCES contatos(id),
  valor_original_centavos INTEGER NOT NULL,
  valor_acordo_centavos INTEGER NOT NULL,
  parcelas INTEGER NOT NULL,
  primeiro_vencimento TEXT NOT NULL,
  observacao TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Arquivos (notas, boletos, contratos, comprovantes). O conteúdo fica em disco (BPO_ARQUIVOS).
CREATE TABLE IF NOT EXISTS documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  lancamento_id INTEGER REFERENCES lancamentos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('nota','boleto','contrato','comprovante','extrato','outro')),
  nome TEXT NOT NULL,
  tamanho INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  arquivo TEXT NOT NULL,
  descricao TEXT,
  enviado_por_usuario INTEGER REFERENCES usuarios(id),
  enviado_por_responsavel INTEGER REFERENCES responsaveis(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documentos_empresa ON documentos(empresa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_documentos_lanc ON documentos(lancamento_id);

-- Orçamento mensal por categoria.
CREATE TABLE IF NOT EXISTS orcamentos (
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  categoria_id INTEGER NOT NULL REFERENCES categorias(id),
  mes TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  PRIMARY KEY (empresa_id, categoria_id, mes)
);

-- Fechamento mensal: cada etapa concluída de um mês. A etapa 'fechado' trava o período.
CREATE TABLE IF NOT EXISTS fechamentos (
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  mes TEXT NOT NULL,
  etapa TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  concluido_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (empresa_id, mes, etapa)
);

-- Conversa entre a equipe e o cliente (Portal).
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  autor TEXT NOT NULL CHECK (autor IN ('equipe','cliente')),
  usuario_id INTEGER REFERENCES usuarios(id),
  responsavel_id INTEGER REFERENCES responsaveis(id),
  texto TEXT NOT NULL,
  lida_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mensagens_empresa ON mensagens(empresa_id, id);

-- Chaves de API para sistemas de gestão (ERP) enviarem lançamentos. Só o hash fica gravado.
CREATE TABLE IF NOT EXISTS chaves_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  prefixo TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  ultimo_uso TEXT,
  revogada_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

// [tabela, coluna, definição]
const COLUNAS_V2 = [
  ['usuarios', 'alcada_aprovacao_centavos', 'INTEGER'], // NULL = padrão do perfil; -1 = sem limite; 0 = não aprova
  ['usuarios', 'totp_segredo', 'TEXT'],
  ['usuarios', 'totp_ativo', 'INTEGER NOT NULL DEFAULT 0'],
  ['usuarios', 'totp_ultimo_passo', 'INTEGER'],
  ['empresas', 'aprovacao_ativa', 'INTEGER NOT NULL DEFAULT 0'],
  ['empresas', 'aprovacao_acima_centavos', 'INTEGER NOT NULL DEFAULT 0'],
  ['empresas', 'chave_pix_cobranca', 'TEXT'],
  ['categorias', 'conta_contabil', 'TEXT'],
  ['contas_bancarias', 'conta_contabil', 'TEXT'],
  ['lancamentos', 'recorrente', 'INTEGER NOT NULL DEFAULT 0'],
  ['lancamentos', 'origem_id', 'INTEGER REFERENCES lancamentos(id)'],
  // dispensada | conferencia | pendente | aprovada | recusada
  ['lancamentos', 'aprovacao', "TEXT NOT NULL DEFAULT 'dispensada'"],
  ['lancamentos', 'acordo_id', 'INTEGER REFERENCES acordos(id)'],
  ['lancamentos', 'renegociado_acordo_id', 'INTEGER REFERENCES acordos(id)'],
  ['auditoria', 'responsavel_id', 'INTEGER REFERENCES responsaveis(id)'],
];

function migrar(db) {
  db.exec(SCHEMA_V2);
  for (const [tabela, coluna, def] of COLUNAS_V2) {
    const existe = db.prepare(`SELECT 1 FROM pragma_table_info('${tabela}') WHERE name = ?`).get(coluna);
    if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${def}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_lanc_aprovacao ON lancamentos(empresa_id, aprovacao) WHERE aprovacao IN ('conferencia','pendente')");
}

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (arquivo !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrar(db);
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
