'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

/**
 * Convenções do banco:
 *  - dinheiro em centavos (inteiro);
 *  - quantidade em milésimos (1 unidade = 1000, 350 g = 350), para pesáveis e unitários na mesma conta;
 *  - percentuais em pontos-base (1500 = 15,00%);
 *  - carimbos de tempo em ISO 8601 (UTC); datas de vencimento e validade em 'AAAA-MM-DD' (fuso do mercadinho).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS moradores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  bloco TEXT NOT NULL DEFAULT '-',
  unidade TEXT NOT NULL,
  telefone TEXT,
  email TEXT,
  documento TEXT,
  -- Limite da conta do mês (fiado). NULL usa o limite padrão das configurações.
  limite_centavos INTEGER CHECK (limite_centavos IS NULL OR limite_centavos >= 0),
  fiado_liberado INTEGER NOT NULL DEFAULT 1,
  -- Senha numérica que o morador digita no terminal para lançar a compra na conta.
  pin_hash TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  observacao TEXT,
  criado_em TEXT NOT NULL,
  UNIQUE (bloco, unidade, nome)
);
CREATE INDEX IF NOT EXISTS idx_moradores_unidade ON moradores(bloco, unidade);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  telefone TEXT,
  senha_hash TEXT NOT NULL,
  -- admin: tudo; gerente: operação e financeiro; caixa: PDV; estoque: produtos e compras; morador: só a própria conta.
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','gerente','caixa','estoque','morador')),
  morador_id INTEGER REFERENCES moradores(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cor TEXT NOT NULL DEFAULT '#6E8BFF',
  ativa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fornecedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  cnpj TEXT UNIQUE,
  contato TEXT,
  telefone TEXT,
  email TEXT,
  prazo_entrega_dias INTEGER NOT NULL DEFAULT 3 CHECK (prazo_entrega_dias >= 0),
  prazo_pagamento_dias INTEGER NOT NULL DEFAULT 28 CHECK (prazo_pagamento_dias >= 0),
  observacao TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_barras TEXT UNIQUE,
  nome TEXT NOT NULL,
  categoria_id INTEGER REFERENCES categorias(id),
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  unidade TEXT NOT NULL DEFAULT 'un' CHECK (unidade IN ('un','kg','l','cx','pct')),
  pesavel INTEGER NOT NULL DEFAULT 0,
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  custo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_centavos >= 0),
  estoque_mil INTEGER NOT NULL DEFAULT 0,
  estoque_minimo_mil INTEGER NOT NULL DEFAULT 0 CHECK (estoque_minimo_mil >= 0),
  controla_validade INTEGER NOT NULL DEFAULT 0,
  -- Nome do arquivo da foto em data/fotos (ex.: "12-a1b2c3d4.jpg"). NULL mostra o desenho de reserva.
  foto TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_produtos_nome ON produtos(nome);
CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria_id, ativo);

-- Lotes com validade (só para produtos que controlam validade). A baixa na venda sai do lote que vence primeiro.
CREATE TABLE IF NOT EXISTS lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  validade TEXT NOT NULL,
  qtd_mil INTEGER NOT NULL,
  custo_centavos INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lotes_produto ON lotes(produto_id, validade);

CREATE TABLE IF NOT EXISTS estoque_mov (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','venda','devolucao','ajuste','perda','inventario')),
  qtd_mil INTEGER NOT NULL, -- positivo entra, negativo sai
  saldo_mil INTEGER NOT NULL, -- saldo do produto depois do movimento
  custo_centavos INTEGER NOT NULL DEFAULT 0,
  documento TEXT,
  observacao TEXT,
  venda_id INTEGER REFERENCES vendas(id),
  compra_id INTEGER REFERENCES compras(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mov_produto ON estoque_mov(produto_id, id);
CREATE INDEX IF NOT EXISTS idx_mov_data ON estoque_mov(criado_em);

CREATE TABLE IF NOT EXISTS inventarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  descricao TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','aplicado','cancelado')),
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  aplicado_em TEXT,
  aplicado_por INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS inventario_itens (
  inventario_id INTEGER NOT NULL REFERENCES inventarios(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  esperado_mil INTEGER NOT NULL,
  contado_mil INTEGER NOT NULL,
  PRIMARY KEY (inventario_id, produto_id)
);

-- Sessão de caixa: abre com o troco, recebe vendas, sangrias e suprimentos, fecha com a conferência do dinheiro.
CREATE TABLE IF NOT EXISTS caixas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  abertura_centavos INTEGER NOT NULL DEFAULT 0 CHECK (abertura_centavos >= 0),
  aberto_em TEXT NOT NULL,
  fechado_em TEXT,
  fechado_por INTEGER REFERENCES usuarios(id),
  esperado_centavos INTEGER,
  informado_centavos INTEGER,
  diferenca_centavos INTEGER,
  observacao TEXT,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado'))
);
CREATE INDEX IF NOT EXISTS idx_caixas_status ON caixas(status, id);

CREATE TABLE IF NOT EXISTS caixa_mov (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caixa_id INTEGER NOT NULL REFERENCES caixas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('suprimento','sangria')),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  motivo TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_caixa_mov ON caixa_mov(caixa_id, id);

-- Terminais de autoatendimento (o tablet/computador do balcão). O aparelho é pareado uma vez
-- com um código gerado pela administração e passa a usar um token próprio, sem senha de ninguém.
CREATE TABLE IF NOT EXISTS terminais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  codigo_hash TEXT NOT NULL,
  pareado_em TEXT,
  ultimo_uso TEXT,
  ultimo_ip TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS vendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caixa_id INTEGER REFERENCES caixas(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  terminal_id INTEGER REFERENCES terminais(id),
  morador_id INTEGER REFERENCES moradores(id),
  origem TEXT NOT NULL DEFAULT 'pdv' CHECK (origem IN ('pdv','autoatendimento')),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga','cancelada')),
  subtotal_centavos INTEGER NOT NULL DEFAULT 0,
  desconto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (desconto_centavos >= 0),
  total_centavos INTEGER NOT NULL DEFAULT 0,
  custo_centavos INTEGER NOT NULL DEFAULT 0,
  criada_em TEXT NOT NULL,
  fechada_em TEXT,
  cancelada_em TEXT,
  cancelada_por INTEGER REFERENCES usuarios(id),
  motivo_cancelamento TEXT
);
CREATE INDEX IF NOT EXISTS idx_vendas_status ON vendas(status, id);
CREATE INDEX IF NOT EXISTS idx_vendas_caixa ON vendas(caixa_id, status);
CREATE INDEX IF NOT EXISTS idx_vendas_fechada ON vendas(fechada_em);
CREATE INDEX IF NOT EXISTS idx_vendas_morador ON vendas(morador_id, fechada_em);

CREATE TABLE IF NOT EXISTS venda_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  descricao TEXT NOT NULL,
  qtd_mil INTEGER NOT NULL CHECK (qtd_mil > 0),
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  desconto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (desconto_centavos >= 0),
  total_centavos INTEGER NOT NULL,
  custo_centavos INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_itens_venda ON venda_itens(venda_id);
CREATE INDEX IF NOT EXISTS idx_itens_produto ON venda_itens(produto_id);

CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  forma TEXT NOT NULL CHECK (forma IN ('dinheiro','pix','debito','credito','fiado')),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  recebido_centavos INTEGER,
  troco_centavos INTEGER NOT NULL DEFAULT 0,
  parcelas INTEGER NOT NULL DEFAULT 1 CHECK (parcelas BETWEEN 1 AND 12),
  transacao_id INTEGER REFERENCES transacoes_cartao(id),
  -- Pagamento do terminal confirmado pelo próprio cliente (PIX): a gestão confere depois no extrato.
  conferido_em TEXT,
  conferido_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_venda ON pagamentos(venda_id);

-- Maquininhas de cartão. 'simulado' para testes, 'ponte' para o agente TEF/pinpad instalado no caixa,
-- 'mercadopago' para a API Point (maquininha inteligente conectada à internet).
CREATE TABLE IF NOT EXISTS maquininhas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  provedor TEXT NOT NULL CHECK (provedor IN ('simulado','ponte','mercadopago')),
  identificador TEXT, -- número de série / device id da maquininha
  url TEXT,           -- endereço da ponte TEF local (ex.: http://127.0.0.1:9090)
  token TEXT,         -- credencial do provedor (fica só no servidor)
  taxa_debito_bp INTEGER NOT NULL DEFAULT 149 CHECK (taxa_debito_bp >= 0),
  taxa_credito_bp INTEGER NOT NULL DEFAULT 349 CHECK (taxa_credito_bp >= 0),
  taxa_parcelado_bp INTEGER NOT NULL DEFAULT 449 CHECK (taxa_parcelado_bp >= 0),
  prazo_debito_dias INTEGER NOT NULL DEFAULT 1 CHECK (prazo_debito_dias >= 0),
  prazo_credito_dias INTEGER NOT NULL DEFAULT 30 CHECK (prazo_credito_dias >= 0),
  ativa INTEGER NOT NULL DEFAULT 1,
  criada_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transacoes_cartao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maquininha_id INTEGER NOT NULL REFERENCES maquininhas(id),
  venda_id INTEGER REFERENCES vendas(id),
  forma TEXT NOT NULL CHECK (forma IN ('debito','credito')),
  parcelas INTEGER NOT NULL DEFAULT 1 CHECK (parcelas BETWEEN 1 AND 12),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  taxa_centavos INTEGER NOT NULL DEFAULT 0,
  liquido_centavos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','negada','cancelada','expirada')),
  nsu TEXT,
  autorizacao TEXT,
  bandeira TEXT,
  externo_id TEXT,
  mensagem TEXT,
  previsao_credito TEXT,
  criada_em TEXT NOT NULL,
  atualizada_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transacoes_status ON transacoes_cartao(status, id);
CREATE INDEX IF NOT EXISTS idx_transacoes_venda ON transacoes_cartao(venda_id);

-- Conta corrente do morador (o "fiado" do mercadinho). Positivo: o morador deve; negativo: tem crédito.
CREATE TABLE IF NOT EXISTS conta_morador (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  morador_id INTEGER NOT NULL REFERENCES moradores(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('compra','pagamento','ajuste','estorno')),
  descricao TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  venda_id INTEGER REFERENCES vendas(id),
  fatura_id INTEGER REFERENCES faturas(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conta_morador ON conta_morador(morador_id, id);

CREATE TABLE IF NOT EXISTS faturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  morador_id INTEGER NOT NULL REFERENCES moradores(id),
  competencia TEXT NOT NULL,
  compras INTEGER NOT NULL DEFAULT 0,
  valor_centavos INTEGER NOT NULL,
  vencimento TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga','cancelada')),
  criada_em TEXT NOT NULL,
  criada_por INTEGER REFERENCES usuarios(id),
  paga_em TEXT,
  UNIQUE (morador_id, competencia)
);
CREATE INDEX IF NOT EXISTS idx_faturas_status ON faturas(status, vencimento);

CREATE TABLE IF NOT EXISTS compras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  numero_nota TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','enviada','recebida','cancelada')),
  previsao TEXT,
  frete_centavos INTEGER NOT NULL DEFAULT 0 CHECK (frete_centavos >= 0),
  desconto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (desconto_centavos >= 0),
  total_centavos INTEGER NOT NULL DEFAULT 0,
  parcelas INTEGER NOT NULL DEFAULT 1 CHECK (parcelas BETWEEN 1 AND 12),
  observacao TEXT,
  criada_em TEXT NOT NULL,
  criada_por INTEGER REFERENCES usuarios(id),
  enviada_em TEXT,
  recebida_em TEXT,
  recebida_por INTEGER REFERENCES usuarios(id),
  cancelada_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_compras_status ON compras(status, id);

CREATE TABLE IF NOT EXISTS compra_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compra_id INTEGER NOT NULL REFERENCES compras(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  qtd_mil INTEGER NOT NULL CHECK (qtd_mil > 0),
  custo_centavos INTEGER NOT NULL CHECK (custo_centavos >= 0),
  total_centavos INTEGER NOT NULL,
  recebido_mil INTEGER,
  validade TEXT,
  preco_sugerido_centavos INTEGER
);
CREATE INDEX IF NOT EXISTS idx_compra_itens ON compra_itens(compra_id);

-- Contas a pagar e a receber. As compras recebidas e as faturas dos moradores geram lançamentos automaticamente.
CREATE TABLE IF NOT EXISTS lancamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('pagar','receber')),
  descricao TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'Outros',
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  morador_id INTEGER REFERENCES moradores(id),
  compra_id INTEGER REFERENCES compras(id),
  fatura_id INTEGER REFERENCES faturas(id),
  transacao_id INTEGER REFERENCES transacoes_cartao(id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  vencimento TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','pago','cancelado')),
  pago_em TEXT,
  pago_centavos INTEGER,
  forma TEXT,
  observacao TEXT,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_lanc_tipo ON lancamentos(tipo, status, vencimento);
CREATE INDEX IF NOT EXISTS idx_lanc_pago ON lancamentos(pago_em);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditoria_data ON auditoria(criado_em);
`;

const CATEGORIAS_PADRAO = [
  ['Mercearia', '#F2A33C'], ['Bebidas', '#4FA3F7'], ['Hortifrúti', '#54C08A'], ['Padaria', '#D9A066'],
  ['Frios e laticínios', '#F2D04B'], ['Congelados', '#6ED3E8'], ['Doces e salgadinhos', '#F2708A'],
  ['Limpeza', '#8E7BF2'], ['Higiene', '#54C9C9'], ['Outros', '#9AA0AA'],
];

const CONFIG_PADRAO = {
  nome_mercado: 'Mercado Binho',
  condominio: '',
  cnpj: '',
  endereco: '',
  // Conta do morador (fiado): limite padrão de consumo no mês e dia de vencimento da fatura.
  limite_fiado_padrao_centavos: '30000',
  vencimento_fatura_dia: '10',
  // Avisa quando faltar este número de dias para o produto vencer.
  alerta_validade_dias: '30',
  // Margem sugerida sobre o custo ao receber uma compra (pontos-base: 3500 = 35%).
  margem_padrao_bp: '3500',
  // Deixa a venda sair mesmo sem saldo no estoque (útil enquanto o cadastro está sendo ajustado).
  permitir_estoque_negativo: '0',
  // Formas que o terminal do cliente aceita (dinheiro fica de fora: não há quem dê troco).
  // A conta do morador vem desligada: ligue em Configurações > Loja se o mercadinho vender fiado no terminal.
  terminal_pix: '1',
  terminal_cartao: '1',
  terminal_conta: '0',
  // Segundos até o terminal voltar sozinho para a tela inicial depois da compra.
  terminal_segundos_fim: '12',
  pix_chave: '',
  pix_recebedor: 'MERCADINHO DO CONDOMINIO',
  pix_cidade: 'SAO PAULO',
};

const agora = () => new Date().toISOString();

/** Colunas acrescentadas depois da primeira versão: entram sozinhas em bancos que já existem. */
const COLUNAS_NOVAS = [
  ['produtos', 'foto', 'TEXT'],
  ['moradores', 'pin_hash', 'TEXT'],
  ['vendas', 'terminal_id', 'INTEGER REFERENCES terminais(id)'],
  ['pagamentos', 'conferido_em', 'TEXT'],
  ['pagamentos', 'conferido_por', 'INTEGER REFERENCES usuarios(id)'],
];

function migrar(db) {
  for (const [tabela, coluna, tipo] of COLUNAS_NOVAS) {
    const existe = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(tabela, coluna);
    if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
}

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrar(db);

  const cat = db.prepare('INSERT OR IGNORE INTO categorias (nome, cor) VALUES (?, ?)');
  for (const c of CATEGORIAS_PADRAO) cat.run(...c);
  const cfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, val] of Object.entries(CONFIG_PADRAO)) cfg.run(k, val);

  const temAdmin = db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'admin' LIMIT 1").get();
  if (!temAdmin) {
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'admin', ?)")
      .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), agora());
  }
  if (!db.prepare('SELECT 1 FROM maquininhas LIMIT 1').get()) {
    db.prepare(`INSERT INTO maquininhas (nome, provedor, identificador, criada_em) VALUES ('Maquininha do caixa', 'simulado', 'DEMO-0001', ?)`).run(agora());
  }
  return db;
}

const abertas = new WeakSet();
/** Executa fn numa transação (aninhada vira parte da externa). */
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

/** Configurações já convertidas (números como número, liga/desliga como booleano). */
function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  return {
    nome_mercado: c.nome_mercado,
    condominio: c.condominio,
    cnpj: c.cnpj,
    endereco: c.endereco,
    limite_fiado_padrao_centavos: Number(c.limite_fiado_padrao_centavos),
    vencimento_fatura_dia: Number(c.vencimento_fatura_dia),
    alerta_validade_dias: Number(c.alerta_validade_dias),
    margem_padrao_bp: Number(c.margem_padrao_bp),
    permitir_estoque_negativo: c.permitir_estoque_negativo === '1',
    terminal_pix: c.terminal_pix === '1',
    terminal_cartao: c.terminal_cartao === '1',
    terminal_conta: c.terminal_conta === '1',
    terminal_segundos_fim: Number(c.terminal_segundos_fim),
    pix_chave: c.pix_chave,
    pix_recebedor: c.pix_recebedor,
    pix_cidade: c.pix_cidade,
  };
}

const gravarConfig = (db, chave, valor) => db.prepare('INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(chave, String(valor));

module.exports = { abrir, transacao, lerConfig, gravarConfig, agora, CONFIG_PADRAO, CATEGORIAS_PADRAO };
