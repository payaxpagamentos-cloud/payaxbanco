'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Valores em centavos (inteiros). Carimbos de tempo em ISO 8601 (UTC); datas de caixa e conferência são o dia local (PDV_FUSO).
const SCHEMA = `
-- Empresas atendidas: cada provedor tem o seu IXC, as suas lojas, os seus PDVs e as suas maquininhas.
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  documento TEXT,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','bloqueada','excluida')),
  email TEXT,
  telefone TEXT,
  motivo_bloqueio TEXT,
  criada_em TEXT NOT NULL
);

-- master e suporte: equipe da plataforma (empresa_id nulo). admin, supervisor e operador: da empresa.
-- O operador atende no PDV; o supervisor confere e autoriza; o admin configura.
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('master','suporte','admin','supervisor','operador')),
  empresa_id INTEGER REFERENCES empresas(id),
  loja_id INTEGER REFERENCES lojas(id) ON DELETE SET NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL,
  CHECK ((perfil IN ('master','suporte')) = (empresa_id IS NULL))
);

-- Lojas / pontos de atendimento da empresa.
CREATE TABLE IF NOT EXISTS lojas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  endereco TEXT,
  -- Filial correspondente no IXC (usada na baixa, quando o provedor trabalha com mais de uma).
  ixc_filial_id TEXT,
  ativa INTEGER NOT NULL DEFAULT 1,
  criada_em TEXT NOT NULL
);

-- Estações de caixa (um computador no balcão). O caixa é aberto sempre num PDV.
-- Com autoatendimento ligado, o mesmo PDV também atende a tela do cliente (o cliente digita o CPF e paga no cartão):
-- a chave identifica a tela e o usuário "Autoatendimento" assina os recebimentos feitos por ela.
CREATE TABLE IF NOT EXISTS pdvs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  loja_id INTEGER NOT NULL REFERENCES lojas(id),
  nome TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  autoatendimento INTEGER NOT NULL DEFAULT 0,
  chave_prefixo TEXT UNIQUE,
  chave_hash TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  UNIQUE (loja_id, nome)
);

-- Configuração da empresa: credenciais do IXC (token cifrado), regras de cobrança e textos do comprovante.
CREATE TABLE IF NOT EXISTS config_empresa (
  empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id),
  ixc_url TEXT,
  ixc_token_cifrado TEXT,
  ixc_ativo INTEGER NOT NULL DEFAULT 0,
  -- id da conta/caixa e do tipo de recebimento no IXC; o mapa liga cada forma de pagamento do PDV ao tipo do IXC.
  ixc_conta_id TEXT,
  ixc_tipos_recebimento TEXT NOT NULL DEFAULT '{}',
  -- Baixa a fatura no IXC assim que o recebimento é confirmado (desligado: o PDV só registra e a baixa é enviada depois).
  baixa_automatica INTEGER NOT NULL DEFAULT 1,
  multa_percentual REAL NOT NULL DEFAULT 2 CHECK (multa_percentual >= 0 AND multa_percentual <= 100),
  juros_mes_percentual REAL NOT NULL DEFAULT 1 CHECK (juros_mes_percentual >= 0 AND juros_mes_percentual <= 100),
  desconto_max_percentual REAL NOT NULL DEFAULT 0 CHECK (desconto_max_percentual >= 0 AND desconto_max_percentual <= 100),
  -- Exige caixa aberto para receber e permite (ou não) recebimento sem fatura do IXC.
  exigir_caixa INTEGER NOT NULL DEFAULT 1,
  permitir_avulso INTEGER NOT NULL DEFAULT 1,
  comprovante_cabecalho TEXT,
  comprovante_rodape TEXT,
  -- Tela do cliente (autoatendimento): logo, chamada e recado que aparecem para quem está pagando.
  logo_url TEXT,
  autoatendimento_fundo TEXT,
  autoatendimento_fundo_marca INTEGER NOT NULL DEFAULT 0,
  autoatendimento_titulo TEXT,
  autoatendimento_subtitulo TEXT,
  autoatendimento_mensagem TEXT,
  atualizado_em TEXT NOT NULL
);

-- Maquininhas de cartão. A chave (pdv_<prefixo>_<segredo>) identifica a maquininha na API de integração; só o hash fica guardado.
-- modo: agente   = o aplicativo da maquininha busca as cobranças no PDV e devolve o resultado;
--       webhook  = o PDV envia a cobrança para o endereço do adquirente/intermediador e recebe o retorno;
--       manual   = sem integração: o operador digita NSU e autorização lidos no comprovante da maquininha.
CREATE TABLE IF NOT EXISTS terminais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  loja_id INTEGER NOT NULL REFERENCES lojas(id),
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  nome TEXT NOT NULL,
  adquirente TEXT NOT NULL DEFAULT 'outro' CHECK (adquirente IN ('stone','cielo','rede','getnet','pagbank','mercadopago','sipag','safrapay','outro')),
  modelo TEXT,
  serial TEXT,
  modo TEXT NOT NULL DEFAULT 'agente' CHECK (modo IN ('agente','webhook','manual')),
  -- O que este aparelho aceita: ["debito","credito","pix"]. A maquininha da Getnet (Santander), por exemplo,
  -- faz crédito e débito pelo deeplink de pagamento, mas não PIX.
  formas TEXT NOT NULL DEFAULT '["debito","credito","pix"]',
  endereco TEXT,
  token_cifrado TEXT,
  chave_prefixo TEXT UNIQUE,
  chave_hash TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_contato TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terminais_empresa ON terminais(empresa_id, ativo);

-- Sessão de caixa: abre com o fundo de troco, recebe, e fecha com a contagem do operador.
CREATE TABLE IF NOT EXISTS caixas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  loja_id INTEGER NOT NULL REFERENCES lojas(id),
  pdv_id INTEGER NOT NULL REFERENCES pdvs(id),
  operador_id INTEGER NOT NULL REFERENCES usuarios(id),
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado','conferido')),
  data TEXT NOT NULL,
  fundo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (fundo_centavos >= 0),
  aberto_em TEXT NOT NULL,
  fechado_em TEXT,
  fechado_por INTEGER REFERENCES usuarios(id),
  -- Contagem informada no fechamento, por forma de pagamento: { "dinheiro": 12345, "pix": 0, ... }
  contagem TEXT,
  diferenca_centavos INTEGER,
  observacao TEXT,
  conferido_em TEXT,
  conferido_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_caixas_empresa ON caixas(empresa_id, data);
CREATE UNIQUE INDEX IF NOT EXISTS idx_caixa_aberto_pdv ON caixas(pdv_id) WHERE status = 'aberto';

-- Sangria (retirada) e suprimento (reforço de troco) do caixa.
CREATE TABLE IF NOT EXISTS movimentos_caixa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caixa_id INTEGER NOT NULL REFERENCES caixas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('sangria','suprimento')),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  motivo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movimentos_caixa ON movimentos_caixa(caixa_id);

-- Um recebimento = um atendimento no balcão: as faturas escolhidas e as formas de pagamento usadas.
-- ixc_status acompanha a baixa no IXC; conferencia acompanha o confronto com o que o IXC devolve.
CREATE TABLE IF NOT EXISTS recebimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  numero INTEGER NOT NULL,
  caixa_id INTEGER REFERENCES caixas(id),
  loja_id INTEGER NOT NULL REFERENCES lojas(id),
  operador_id INTEGER NOT NULL REFERENCES usuarios(id),
  origem TEXT NOT NULL DEFAULT 'balcao' CHECK (origem IN ('balcao','autoatendimento')),
  data TEXT NOT NULL,
  cliente_ixc_id TEXT,
  cliente_nome TEXT NOT NULL,
  cliente_documento TEXT,
  contrato_ixc_id TEXT,
  valor_titulos_centavos INTEGER NOT NULL DEFAULT 0,
  acrescimo_centavos INTEGER NOT NULL DEFAULT 0,
  desconto_centavos INTEGER NOT NULL DEFAULT 0,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  recebido_centavos INTEGER NOT NULL DEFAULT 0,
  troco_centavos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado','cancelado')),
  ixc_status TEXT NOT NULL DEFAULT 'pendente' CHECK (ixc_status IN ('pendente','enviando','baixado','parcial','erro','manual','avulso','estornado')),
  ixc_tentativas INTEGER NOT NULL DEFAULT 0,
  ixc_erro TEXT,
  ixc_enviado_em TEXT,
  conferencia TEXT NOT NULL DEFAULT 'pendente' CHECK (conferencia IN ('pendente','conferido','divergente')),
  conferido_em TEXT,
  conferido_por INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  criado_em TEXT NOT NULL,
  cancelado_em TEXT,
  cancelado_por INTEGER REFERENCES usuarios(id),
  motivo_cancelamento TEXT,
  UNIQUE (empresa_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_recebimentos_data ON recebimentos(empresa_id, data);
CREATE INDEX IF NOT EXISTS idx_recebimentos_caixa ON recebimentos(caixa_id);
CREATE INDEX IF NOT EXISTS idx_recebimentos_ixc ON recebimentos(empresa_id, ixc_status);
CREATE INDEX IF NOT EXISTS idx_recebimentos_cliente ON recebimentos(empresa_id, cliente_ixc_id);

-- Faturas do IXC pagas no recebimento (uma linha por título). Guarda o que foi cobrado e o que o IXC confirmou.
CREATE TABLE IF NOT EXISTS recebimento_titulos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recebimento_id INTEGER NOT NULL REFERENCES recebimentos(id) ON DELETE CASCADE,
  fatura_ixc_id TEXT,
  contrato_ixc_id TEXT,
  documento TEXT,
  descricao TEXT,
  vencimento TEXT,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  acrescimo_centavos INTEGER NOT NULL DEFAULT 0,
  desconto_centavos INTEGER NOT NULL DEFAULT 0,
  total_centavos INTEGER NOT NULL CHECK (total_centavos >= 0),
  ixc_status TEXT NOT NULL DEFAULT 'pendente' CHECK (ixc_status IN ('pendente','baixado','erro','manual','avulso','estornado')),
  ixc_erro TEXT,
  ixc_baixado_em TEXT,
  -- Última conferência feita no IXC: situação e valor que o IXC devolveu para esta fatura.
  conferido_em TEXT,
  ixc_situacao TEXT,
  ixc_valor_centavos INTEGER,
  ixc_data_pagamento TEXT
);
CREATE INDEX IF NOT EXISTS idx_titulos_recebimento ON recebimento_titulos(recebimento_id);
CREATE INDEX IF NOT EXISTS idx_titulos_fatura ON recebimento_titulos(fatura_ixc_id);

-- Formas de pagamento usadas no recebimento (um recebimento pode ter várias).
CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recebimento_id INTEGER NOT NULL REFERENCES recebimentos(id) ON DELETE CASCADE,
  forma TEXT NOT NULL CHECK (forma IN ('dinheiro','pix','debito','credito','transferencia','outro')),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  parcelas INTEGER NOT NULL DEFAULT 1 CHECK (parcelas BETWEEN 1 AND 24),
  terminal_id INTEGER REFERENCES terminais(id),
  transacao_id INTEGER REFERENCES transacoes_cartao(id),
  bandeira TEXT,
  nsu TEXT,
  autorizacao TEXT,
  cartao_final TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_recebimento ON pagamentos(recebimento_id);

-- Cobranças enviadas à maquininha. Enquanto não há resposta, o PDV espera; aprovada, vira um pagamento do recebimento.
CREATE TABLE IF NOT EXISTS transacoes_cartao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  terminal_id INTEGER NOT NULL REFERENCES terminais(id),
  operador_id INTEGER REFERENCES usuarios(id),
  caixa_id INTEGER REFERENCES caixas(id),
  referencia TEXT NOT NULL UNIQUE,
  forma TEXT NOT NULL CHECK (forma IN ('debito','credito','pix')),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  parcelas INTEGER NOT NULL DEFAULT 1 CHECK (parcelas BETWEEN 1 AND 24),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','aprovada','negada','cancelada','expirada','estornada')),
  bandeira TEXT,
  nsu TEXT,
  autorizacao TEXT,
  cartao_final TEXT,
  -- CV da transação (Getnet: cvNumber), pedido pela maquininha para estornar no mesmo dia.
  cv TEXT,
  mensagem TEXT,
  comprovante TEXT,
  recebimento_id INTEGER REFERENCES recebimentos(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  expira_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transacoes_terminal ON transacoes_cartao(terminal_id, status);
CREATE INDEX IF NOT EXISTS idx_transacoes_empresa ON transacoes_cartao(empresa_id, criado_em);

-- Divergências encontradas na conferência com o IXC (fatura não baixada, valor diferente, baixa sem recebimento no PDV).
CREATE TABLE IF NOT EXISTS divergencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  recebimento_id INTEGER REFERENCES recebimentos(id),
  titulo_id INTEGER REFERENCES recebimento_titulos(id),
  caixa_id INTEGER REFERENCES caixas(id),
  data TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('nao_baixado','valor_diferente','baixa_nao_confirmada','fatura_sumiu','caixa_diferenca','cancelado_com_baixa')),
  detalhes TEXT,
  valor_pdv_centavos INTEGER,
  valor_ixc_centavos INTEGER,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','resolvida','ignorada')),
  resolucao TEXT,
  resolvido_em TEXT,
  resolvido_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  UNIQUE (empresa_id, tipo, recebimento_id, titulo_id)
);
CREATE INDEX IF NOT EXISTS idx_divergencias ON divergencias(empresa_id, status, data);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  empresa_id INTEGER REFERENCES empresas(id),
  acao TEXT NOT NULL,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditoria ON auditoria(id DESC);
`;

const CONFIG_PADRAO = {
  nome_plataforma: 'Payax PDV',
  // Quantas vezes o PDV tenta a baixa no IXC antes de deixar o recebimento parado esperando alguém olhar.
  baixa_tentativas: '8',
  // Intervalo (segundos) em que a fila de baixas e a expiração das cobranças no cartão são processadas.
  fila_intervalo_s: '30',
};

const agora = () => new Date().toISOString();

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  // Migrações de instalações feitas antes da tela do cliente.
  const colunas = (tabela) => db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
  const pdvColunas = colunas('pdvs');
  if (!pdvColunas.includes('autoatendimento')) {
    db.exec(`ALTER TABLE pdvs ADD COLUMN autoatendimento INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE pdvs ADD COLUMN chave_prefixo TEXT;
      ALTER TABLE pdvs ADD COLUMN chave_hash TEXT;
      ALTER TABLE pdvs ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pdvs_chave ON pdvs(chave_prefixo) WHERE chave_prefixo IS NOT NULL;`);
  }
  const configColunas = colunas('config_empresa');
  if (!configColunas.includes('logo_url')) {
    db.exec('ALTER TABLE config_empresa ADD COLUMN logo_url TEXT; ALTER TABLE config_empresa ADD COLUMN autoatendimento_mensagem TEXT;');
  }
  if (!colunas('config_empresa').includes('autoatendimento_titulo')) {
    db.exec('ALTER TABLE config_empresa ADD COLUMN autoatendimento_titulo TEXT; ALTER TABLE config_empresa ADD COLUMN autoatendimento_subtitulo TEXT;');
  }
  if (!colunas('config_empresa').includes('autoatendimento_fundo')) {
    db.exec('ALTER TABLE config_empresa ADD COLUMN autoatendimento_fundo TEXT');
  }
  if (!colunas('terminais').includes('formas')) {
    db.exec(`ALTER TABLE terminais ADD COLUMN formas TEXT NOT NULL DEFAULT '["debito","credito","pix"]'`);
  }
  if (!colunas('transacoes_cartao').includes('cv')) {
    db.exec('ALTER TABLE transacoes_cartao ADD COLUMN cv TEXT');
  }
  if (!colunas('config_empresa').includes('autoatendimento_fundo_marca')) {
    db.exec('ALTER TABLE config_empresa ADD COLUMN autoatendimento_fundo_marca INTEGER NOT NULL DEFAULT 0');
  }
  if (!colunas('recebimentos').includes('origem')) {
    db.exec("ALTER TABLE recebimentos ADD COLUMN origem TEXT NOT NULL DEFAULT 'balcao'");
  }

  const cfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, val] of Object.entries(CONFIG_PADRAO)) cfg.run(k, val);

  if (!db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'master' LIMIT 1").get()) {
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'master', ?)")
      .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), agora());
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

/** Configurações da plataforma: números, exceto o nome. */
function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  return Object.fromEntries(Object.keys(CONFIG_PADRAO).map((k) => [k, k === 'nome_plataforma' ? c[k] : Number(c[k])]));
}

module.exports = { abrir, transacao, lerConfig, agora, CONFIG_PADRAO };
