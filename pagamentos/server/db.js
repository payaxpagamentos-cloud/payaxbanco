'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');
const contaInterna = require('./lib/contaInterna');

/*
 * PAY AX Pagamentos — convenções do banco:
 * - Dinheiro sempre em CENTAVOS inteiros. Nunca ponto flutuante.
 * - Percentuais em ppm (partes por milhão da fração): 1% = 10.000 ppm; comissão = valor * ppm / 1.000.000.
 * - Datas de negócio em 'AAAA-MM-DD' (fuso da operação); carimbos de tempo em ISO 8601 UTC.
 * - A conta gráfica do cliente é a tabela `lancamentos`: o saldo é SEMPRE a soma dos lançamentos,
 *   nunca um campo guardado. Nada é apagado — correções entram como estorno/ajuste.
 * - Todo boleto pertence a um cliente e a uma conta bancária nossa (modelo de conta gráfica).
 */
const MIGRACOES = [
  {
    versao: 1,
    nome: 'fundacao',
    sql: `
-- ---------------------------------------------------------------- Equipe PAY AX
CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','financeiro','operacao','consulta')),
  ativo INTEGER NOT NULL DEFAULT 1,
  senha_provisoria INTEGER NOT NULL DEFAULT 0,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL
);

-- ---------------------------------------------------------------- Clientes da plataforma
-- As empresas que emitem boletos por nós (provedores, prestadores). Cada uma tem conta gráfica própria.
CREATE TABLE clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT,
  cnpj TEXT NOT NULL UNIQUE,
  email TEXT,
  telefone TEXT,
  responsavel TEXT,
  -- Endereço do beneficiário, impresso no boleto.
  cep TEXT, endereco TEXT, numero TEXT, complemento TEXT, bairro TEXT, cidade TEXT, uf TEXT,
  situacao TEXT NOT NULL DEFAULT 'implantacao' CHECK (situacao IN ('implantacao','ativo','suspenso','encerrado')),
  -- Conta de destino do repasse (PIX).
  pix_tipo TEXT CHECK (pix_tipo IN ('cpf','cnpj','email','telefone','aleatoria')),
  pix_chave TEXT,
  pix_titular TEXT,
  pix_documento TEXT,
  -- Janela de retenção: o líquido de cada liquidação fica "a liberar" por N dias úteis.
  retencao_dias INTEGER NOT NULL DEFAULT 1 CHECK (retencao_dias BETWEEN 0 AND 30),
  repasse_automatico INTEGER NOT NULL DEFAULT 1,
  -- Não gera repasse abaixo deste valor (acumula para o próximo dia).
  repasse_minimo_centavos INTEGER NOT NULL DEFAULT 1000 CHECK (repasse_minimo_centavos >= 0),
  -- Acima deste valor, o repasse automático para e espera aprovação da nossa equipe (0 = sempre exige).
  repasse_limite_aprovacao_centavos INTEGER NOT NULL DEFAULT 5000000 CHECK (repasse_limite_aprovacao_centavos >= 0),
  -- Teto de emissão por boleto (trava contra erro de digitação e fraude).
  limite_boleto_centavos INTEGER NOT NULL DEFAULT 5000000 CHECK (limite_boleto_centavos > 0),
  observacoes TEXT,
  versao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_clientes_situacao ON clientes(situacao, razao_social);

-- ---------------------------------------------------------------- Nossas contas bancárias
-- Conta gráfica: os boletos de todos os clientes são registrados no NOSSO convênio.
CREATE TABLE contas_bancarias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apelido TEXT NOT NULL,
  banco TEXT NOT NULL DEFAULT '237',
  agencia TEXT NOT NULL,
  agencia_dv TEXT,
  conta TEXT NOT NULL,
  conta_dv TEXT,
  -- Bradesco: código do cedente/convênio e a carteira (09 = com registro, escritural).
  cedente TEXT NOT NULL,
  carteira TEXT NOT NULL DEFAULT '09',
  -- Faixa do nosso número (11 dígitos na carteira 09).
  nosso_numero_inicial INTEGER NOT NULL DEFAULT 1,
  nosso_numero_final INTEGER NOT NULL DEFAULT 99999999999,
  nosso_numero_atual INTEGER NOT NULL DEFAULT 0,
  -- Beneficiário impresso no boleto (nós, na conta gráfica).
  beneficiario_nome TEXT NOT NULL,
  beneficiario_documento TEXT NOT NULL,
  beneficiario_endereco TEXT,
  beneficiario_cidade TEXT,
  beneficiario_uf TEXT,
  beneficiario_cep TEXT,
  -- Chave PIX da conta, usada no QR Code do Bolepix.
  pix_chave TEXT,
  pix_tipo TEXT,
  -- Custo que o BANCO nos cobra (base da margem; o que cobramos do cliente está na tabela precos).
  custo_emissao_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_emissao_centavos >= 0),
  custo_liquidacao_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_liquidacao_centavos >= 0),
  custo_pix_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_pix_centavos >= 0),
  ativa INTEGER NOT NULL DEFAULT 1,
  padrao INTEGER NOT NULL DEFAULT 0,
  versao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

-- ---------------------------------------------------------------- Preços (o que cobramos do cliente)
-- Vigência por cliente: um preço novo encerra o anterior. O boleto congela o preço no momento da emissão.
CREATE TABLE precos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER REFERENCES clientes(id),   -- NULL = tabela padrão da plataforma
  vigencia_inicio TEXT NOT NULL,
  vigencia_fim TEXT,
  -- Cobrado do cliente a cada boleto REGISTRADO (emissão), pago mesmo se não liquidar.
  tarifa_emissao_centavos INTEGER NOT NULL DEFAULT 0 CHECK (tarifa_emissao_centavos >= 0),
  -- Tarifa bancária repassada ao cliente a cada título LIQUIDADO.
  tarifa_liquidacao_centavos INTEGER NOT NULL DEFAULT 0 CHECK (tarifa_liquidacao_centavos >= 0),
  -- Tarifa PAY AX sobre o valor pago, em ppm (1% = 10.000). As colunas mantêm o nome antigo: comissao.
  percentual_ppm INTEGER NOT NULL DEFAULT 0 CHECK (percentual_ppm >= 0 AND percentual_ppm <= 1000000),
  comissao_minima_centavos INTEGER NOT NULL DEFAULT 0 CHECK (comissao_minima_centavos >= 0),
  comissao_maxima_centavos INTEGER,
  -- Tarifa do repasse (PIX) ao cliente.
  tarifa_repasse_centavos INTEGER NOT NULL DEFAULT 0 CHECK (tarifa_repasse_centavos >= 0),
  observacao TEXT,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_precos_cliente ON precos(cliente_id, vigencia_inicio DESC);

-- ---------------------------------------------------------------- Boletos
CREATE TABLE boletos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  conta_id INTEGER NOT NULL REFERENCES contas_bancarias(id),
  nosso_numero TEXT NOT NULL,
  nosso_numero_dv TEXT NOT NULL,
  seu_numero TEXT,                       -- número do documento no sistema do cliente
  origem TEXT NOT NULL DEFAULT 'avulso' CHECK (origem IN ('avulso','ixc','api','lote')),
  ixc_receber_id TEXT,                   -- id do título em fn_areceber
  ixc_cliente_id TEXT,
  tipo TEXT NOT NULL DEFAULT 'boleto' CHECK (tipo IN ('boleto','bolepix')),

  pagador_nome TEXT NOT NULL,
  pagador_documento TEXT NOT NULL,
  pagador_email TEXT,
  pagador_telefone TEXT,
  pagador_cep TEXT, pagador_endereco TEXT, pagador_numero TEXT, pagador_bairro TEXT, pagador_cidade TEXT, pagador_uf TEXT,

  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  emissao TEXT NOT NULL,
  vencimento TEXT NOT NULL,
  especie TEXT NOT NULL DEFAULT 'DM',
  -- Encargos após o vencimento e desconto por antecipação.
  juros_mes_ppm INTEGER NOT NULL DEFAULT 0 CHECK (juros_mes_ppm >= 0),
  multa_ppm INTEGER NOT NULL DEFAULT 0 CHECK (multa_ppm >= 0),
  desconto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (desconto_centavos >= 0),
  desconto_ate TEXT,
  dias_baixa INTEGER NOT NULL DEFAULT 60 CHECK (dias_baixa >= 0),
  mensagem TEXT,

  codigo_barras TEXT,
  linha_digitavel TEXT,
  -- Bolepix: o mesmo título com QR Code PIX (BR Code EMV).
  pix_txid TEXT,
  pix_emv TEXT,

  situacao TEXT NOT NULL DEFAULT 'registrando'
    CHECK (situacao IN ('registrando','registrado','liquidado','baixado','cancelado','falha')),
  erro_registro TEXT,
  registrado_em TEXT,

  pago_em TEXT,                          -- data do crédito (AAAA-MM-DD)
  pago_valor_centavos INTEGER,
  pago_juros_centavos INTEGER NOT NULL DEFAULT 0,
  pago_desconto_centavos INTEGER NOT NULL DEFAULT 0,
  pago_meio TEXT CHECK (pago_meio IN ('boleto','pix')),
  liquidado_em TEXT,
  baixado_em TEXT,
  motivo_baixa TEXT,

  -- Preço congelado na emissão: o cliente não é surpreendido por mudança de tabela.
  preco_id INTEGER REFERENCES precos(id),
  tarifa_emissao_centavos INTEGER NOT NULL DEFAULT 0,
  tarifa_liquidacao_centavos INTEGER NOT NULL DEFAULT 0,
  percentual_ppm INTEGER NOT NULL DEFAULT 0,
  comissao_minima_centavos INTEGER NOT NULL DEFAULT 0,
  comissao_maxima_centavos INTEGER,
  custo_liquidacao_centavos INTEGER NOT NULL DEFAULT 0,

  versao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_por_cliente INTEGER
);
CREATE UNIQUE INDEX idx_boletos_nosso_numero ON boletos(conta_id, nosso_numero);
CREATE INDEX idx_boletos_cliente ON boletos(cliente_id, situacao, vencimento);
CREATE INDEX idx_boletos_vencimento ON boletos(vencimento, situacao);
CREATE INDEX idx_boletos_pagador ON boletos(pagador_documento);
CREATE INDEX idx_boletos_ixc ON boletos(cliente_id, ixc_receber_id);
CREATE INDEX idx_boletos_pago ON boletos(pago_em, cliente_id);

-- ---------------------------------------------------------------- Conta gráfica (razão do cliente)
-- O saldo do cliente é a SOMA desta tabela. Positivo credita o cliente; negativo debita.
CREATE TABLE lancamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  boleto_id INTEGER REFERENCES boletos(id),
  repasse_id INTEGER,
  tipo TEXT NOT NULL CHECK (tipo IN ('credito_liquidacao','tarifa_banco','comissao','tarifa_emissao','repasse','taxa_repasse','estorno','ajuste')),
  valor_centavos INTEGER NOT NULL,
  descricao TEXT NOT NULL,
  data_competencia TEXT NOT NULL,        -- data do fato gerador
  data_liberacao TEXT NOT NULL,          -- entra no saldo disponível a partir desta data
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_lanc_cliente ON lancamentos(cliente_id, data_liberacao);
CREATE INDEX idx_lanc_competencia ON lancamentos(cliente_id, data_competencia);
CREATE INDEX idx_lanc_boleto ON lancamentos(boleto_id);
CREATE INDEX idx_lanc_repasse ON lancamentos(repasse_id);

-- ---------------------------------------------------------------- Repasses ao cliente
CREATE TABLE repasses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),      -- bruto consumido do saldo
  taxa_centavos INTEGER NOT NULL DEFAULT 0 CHECK (taxa_centavos >= 0),
  valor_liquido_centavos INTEGER NOT NULL CHECK (valor_liquido_centavos > 0),
  meio TEXT NOT NULL DEFAULT 'pix' CHECK (meio IN ('pix','ted','interno')),
  pix_tipo TEXT, pix_chave TEXT, titular_nome TEXT, titular_documento TEXT,
  situacao TEXT NOT NULL DEFAULT 'aguardando_aprovacao'
    CHECK (situacao IN ('aguardando_aprovacao','aprovado','enviado','confirmado','falhou','cancelado')),
  automatico INTEGER NOT NULL DEFAULT 0,
  end_to_end TEXT,
  erro TEXT,
  solicitado_por INTEGER REFERENCES usuarios(id),
  solicitado_por_cliente INTEGER,
  aprovado_por INTEGER REFERENCES usuarios(id),
  aprovado_em TEXT,
  enviado_em TEXT,
  confirmado_em TEXT,
  versao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_repasses_cliente ON repasses(cliente_id, situacao, criado_em DESC);
CREATE INDEX idx_repasses_situacao ON repasses(situacao, criado_em);

-- ---------------------------------------------------------------- Acesso do cliente final (Área do Cliente)
CREATE TABLE usuarios_cliente (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL DEFAULT 'operador' CHECK (perfil IN ('admin','operador','consulta')),
  ativo INTEGER NOT NULL DEFAULT 1,
  senha_provisoria INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_usuarios_cliente ON usuarios_cliente(cliente_id, ativo);

-- ---------------------------------------------------------------- Integrações (credenciais cifradas)
CREATE TABLE integracoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escopo TEXT NOT NULL CHECK (escopo IN ('banco','ixc')),
  cliente_id INTEGER REFERENCES clientes(id),   -- NULL para o banco (é nosso)
  conta_id INTEGER REFERENCES contas_bancarias(id),
  credenciais TEXT,                             -- JSON cifrado (AES-256-GCM)
  config TEXT,                                  -- JSON não sensível
  estado TEXT NOT NULL DEFAULT 'nao_configurada'
    CHECK (estado IN ('nao_configurada','conectada','falha','desabilitada')),
  ultimo_teste TEXT,
  ultimo_erro TEXT,
  atualizado_em TEXT NOT NULL,
  atualizado_por INTEGER REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX idx_integracoes_escopo ON integracoes(escopo, IFNULL(cliente_id, 0), IFNULL(conta_id, 0));

-- ---------------------------------------------------------------- Avisos do banco (webhook / retorno)
CREATE TABLE eventos_banco (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER REFERENCES contas_bancarias(id),
  tipo TEXT NOT NULL,
  nosso_numero TEXT,
  boleto_id INTEGER REFERENCES boletos(id),
  payload TEXT NOT NULL,
  origem TEXT NOT NULL DEFAULT 'webhook' CHECK (origem IN ('webhook','retorno','consulta','simulador')),
  recebido_em TEXT NOT NULL,
  processado_em TEXT,
  resultado TEXT,
  erro TEXT
);
CREATE INDEX idx_eventos_pendentes ON eventos_banco(processado_em, recebido_em);
CREATE INDEX idx_eventos_boleto ON eventos_banco(boleto_id);

-- ---------------------------------------------------------------- Sincronismo com o IXC
CREATE TABLE sincronismos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('importacao','baixa','teste')),
  inicio TEXT NOT NULL,
  fim TEXT,
  lidos INTEGER NOT NULL DEFAULT 0,
  criados INTEGER NOT NULL DEFAULT 0,
  ignorados INTEGER NOT NULL DEFAULT 0,
  erros INTEGER NOT NULL DEFAULT 0,
  detalhe TEXT,
  disparado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_sinc_cliente ON sincronismos(cliente_id, inicio DESC);

-- ---------------------------------------------------------------- Auditoria e idempotência
CREATE TABLE auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  usuario_tipo TEXT NOT NULL DEFAULT 'equipe' CHECK (usuario_tipo IN ('equipe','cliente','sistema')),
  usuario_nome TEXT,
  cliente_id INTEGER REFERENCES clientes(id),
  acao TEXT NOT NULL,
  entidade TEXT,
  entidade_id INTEGER,
  antes TEXT,
  depois TEXT,
  ip TEXT,
  request_id TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_auditoria_data ON auditoria(criado_em DESC);
CREATE INDEX idx_auditoria_entidade ON auditoria(entidade, entidade_id);

CREATE TABLE idempotencia (
  usuario_chave TEXT NOT NULL,
  chave TEXT NOT NULL,
  rota TEXT NOT NULL,
  status INTEGER,
  corpo TEXT,
  criado_em TEXT NOT NULL,
  PRIMARY KEY (usuario_chave, chave)
);

CREATE TABLE parametros (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
`,
  },
  {
    versao: 2,
    nome: 'consulta-dados',
    sql: `
-- Cache das consultas de CEP e CNPJ: evita repetir a chamada (e gastar crédito) pelo mesmo dado.
CREATE TABLE consultas_cache (
  tipo TEXT NOT NULL CHECK (tipo IN ('cep','cnpj')),
  chave TEXT NOT NULL,
  fonte TEXT NOT NULL,
  dados TEXT NOT NULL,
  consultado_em TEXT NOT NULL,
  PRIMARY KEY (tipo, chave)
);
CREATE INDEX idx_cache_consultado ON consultas_cache(consultado_em);

-- A tabela de integrações passa a aceitar o escopo 'dados' (API Brasil).
-- O CHECK não é alterável no SQLite: a tabela é refeita com os mesmos registros.
CREATE TABLE integracoes_nova (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escopo TEXT NOT NULL CHECK (escopo IN ('banco','ixc','dados')),
  cliente_id INTEGER REFERENCES clientes(id),
  conta_id INTEGER REFERENCES contas_bancarias(id),
  credenciais TEXT,
  config TEXT,
  estado TEXT NOT NULL DEFAULT 'nao_configurada'
    CHECK (estado IN ('nao_configurada','conectada','falha','desabilitada')),
  ultimo_teste TEXT,
  ultimo_erro TEXT,
  atualizado_em TEXT NOT NULL,
  atualizado_por INTEGER REFERENCES usuarios(id)
);
INSERT INTO integracoes_nova SELECT * FROM integracoes;
DROP TABLE integracoes;
ALTER TABLE integracoes_nova RENAME TO integracoes;
CREATE UNIQUE INDEX idx_integracoes_escopo ON integracoes(escopo, IFNULL(cliente_id, 0), IFNULL(conta_id, 0));
`,
  },
  {
    versao: 3,
    nome: 'conta-interna',
    sql: `
-- Número da conta do cliente DENTRO da PAY AX (identidade da conta gráfica).
-- NÃO é a agência/conta do Bradesco: aquela identifica o convênio e vai no código de barras; esta, não.
ALTER TABLE clientes ADD COLUMN agencia_interna TEXT;
ALTER TABLE clientes ADD COLUMN conta_interna TEXT;
ALTER TABLE clientes ADD COLUMN conta_interna_dv TEXT;
CREATE UNIQUE INDEX idx_clientes_conta_interna ON clientes(agencia_interna, conta_interna);

-- Agências internas e o próximo número livre de cada uma. Ao encher, a seguinte é aberta sozinha.
CREATE TABLE contas_internas (
  agencia TEXT PRIMARY KEY,
  nome TEXT,
  proxima INTEGER NOT NULL DEFAULT 1 CHECK (proxima >= 1),
  limite INTEGER NOT NULL DEFAULT 9999 CHECK (limite >= 1),
  criada_em TEXT NOT NULL
);
INSERT INTO contas_internas (agencia, nome, proxima, limite, criada_em)
  VALUES ('001', 'Agência principal', 1, 9999, datetime('now'));
`,
  },
  {
    versao: 4,
    nome: 'seguranca',
    sql: `
-- Autenticação em duas etapas por aplicativo (TOTP), para a equipe e para a Área do Cliente.
ALTER TABLE usuarios ADD COLUMN totp_segredo TEXT;
ALTER TABLE usuarios ADD COLUMN totp_ativo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN totp_ultimo_passo INTEGER;
ALTER TABLE usuarios_cliente ADD COLUMN totp_segredo TEXT;
ALTER TABLE usuarios_cliente ADD COLUMN totp_ativo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios_cliente ADD COLUMN totp_ultimo_passo INTEGER;

-- Histórico dos backups, com o resultado da conferência de cada um.
-- Um backup de livro-razão que ninguém conferiu não serve de nada.
CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  tamanho INTEGER NOT NULL,
  integridade TEXT NOT NULL,              -- 'ok' ou o erro devolvido pelo integrity_check
  lancamentos INTEGER,                    -- quantos lançamentos a cópia tem
  soma_centavos INTEGER,                  -- soma do razão na cópia
  confere INTEGER NOT NULL DEFAULT 0,     -- os totais batem com o banco em uso
  divergencia TEXT,
  automatico INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_backups_data ON backups(criado_em DESC);
`,
  },
  {
    versao: 5,
    nome: 'cnab400',
    sql: `
-- Arquivos de remessa que mandamos ao banco.
CREATE TABLE remessas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas_bancarias(id),
  sequencial INTEGER NOT NULL,
  nome TEXT NOT NULL,
  titulos INTEGER NOT NULL DEFAULT 0,
  valor_centavos INTEGER NOT NULL DEFAULT 0,
  situacao TEXT NOT NULL DEFAULT 'gerada' CHECK (situacao IN ('gerada','entregue','falha')),
  caminho TEXT,
  erro TEXT,
  automatica INTEGER NOT NULL DEFAULT 1,
  entregue_em TEXT,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_remessas_data ON remessas(criado_em DESC);

-- Arquivos de retorno que o banco devolve. A impressão digital impede processar o mesmo arquivo duas vezes.
CREATE TABLE retornos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  impressao TEXT NOT NULL,
  origem TEXT NOT NULL DEFAULT 'pasta' CHECK (origem IN ('pasta','upload')),
  gerado_em TEXT,
  credito_em TEXT,
  registros INTEGER NOT NULL DEFAULT 0,
  liquidados INTEGER NOT NULL DEFAULT 0,
  confirmados INTEGER NOT NULL DEFAULT 0,
  baixados INTEGER NOT NULL DEFAULT 0,
  rejeitados INTEGER NOT NULL DEFAULT 0,
  nao_tratados INTEGER NOT NULL DEFAULT 0,
  sem_titulo INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  detalhe TEXT,
  processado_em TEXT,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX idx_retornos_impressao ON retornos(impressao);

-- Em qual remessa o título foi, se o banco confirmou o registro e por que recusou.
ALTER TABLE boletos ADD COLUMN remessa_id INTEGER REFERENCES remessas(id);
ALTER TABLE boletos ADD COLUMN confirmado_em TEXT;
ALTER TABLE boletos ADD COLUMN motivo_rejeicao TEXT;
-- Instrução que ainda precisa ir ao banco na próxima remessa (02 = baixa, 06 = alteração de vencimento).
ALTER TABLE boletos ADD COLUMN comando_pendente TEXT;
CREATE INDEX idx_boletos_remessa ON boletos(remessa_id);
CREATE INDEX idx_boletos_aguardando ON boletos(situacao, remessa_id);
`,
  },
  {
    versao: 6,
    nome: 'beneficiario-final',
    sql: `
-- Beneficiário final (o antigo sacador/avalista): o cliente em nome de quem o boleto cobra. O título é registrado no
-- convênio da PAY AX (que fica como beneficiário), e o cliente vai junto, registrado no banco
-- e impresso no boleto, para o pagador saber a quem está pagando.
-- Congelado na emissão, como o preço: o boleto continua mostrando quem cobrava naquele dia,
-- igual ao que ficou registrado no banco, mesmo que o cadastro do cliente mude depois.
ALTER TABLE boletos ADD COLUMN beneficiario_final_nome TEXT;
ALTER TABLE boletos ADD COLUMN beneficiario_final_fantasia TEXT;
ALTER TABLE boletos ADD COLUMN beneficiario_final_documento TEXT;
UPDATE boletos SET
  beneficiario_final_nome = (SELECT c.razao_social FROM clientes c WHERE c.id = boletos.cliente_id),
  beneficiario_final_fantasia = (SELECT c.nome_fantasia FROM clientes c WHERE c.id = boletos.cliente_id),
  beneficiario_final_documento = (SELECT c.cnpj FROM clientes c WHERE c.id = boletos.cliente_id);
`,
  },
  {
    versao: 7,
    nome: 'conformidade',
    sql: `
-- Regras de conformidade que dependem de alguém de fora (Bradesco, jurídico, provedor).
-- As regras automáticas não ficam aqui: o sistema as verifica toda vez. O histórico de cada
-- mudança fica na auditoria (acao conformidade.atualizada).
CREATE TABLE conformidade_acompanhamento (
  regra TEXT PRIMARY KEY,
  situacao TEXT NOT NULL CHECK (situacao IN ('pendente', 'em_andamento', 'atendida', 'nao_se_aplica')),
  responsavel TEXT,
  prazo TEXT,
  observacao TEXT,
  atualizado_em TEXT NOT NULL,
  atualizado_por INTEGER REFERENCES usuarios(id)
);
`,
  },
  {
    versao: 8,
    nome: 'codigo-do-cliente',
    sql: `
-- O número de controle do cliente deixa de ter agência: é um código só ("0001-3"), sem termos de
-- instituição financeira. A numeração segue na mesma sequência e não abre outra agência.
UPDATE contas_internas SET limite = 99999999;
`,
  },
  {
    versao: 9,
    nome: 'pld',
    sql: `
-- Prevenção à lavagem de dinheiro (Lei 9.613/1998). Nada aqui é apagado: a lei pede guarda de no
-- mínimo cinco anos (art. 10, paragrafo 2), e o sigilo do art. 11 deixa isto fora da Área do Cliente.
CREATE TABLE pld_alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regra TEXT NOT NULL,
  chave TEXT NOT NULL UNIQUE,              -- a mesma situação nunca gera dois alertas
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  boleto_id INTEGER REFERENCES boletos(id),
  descricao TEXT NOT NULL,
  valor_centavos INTEGER,
  detalhes TEXT,                           -- JSON
  situacao TEXT NOT NULL DEFAULT 'novo'
    CHECK (situacao IN ('novo', 'em_analise', 'a_comunicar', 'comunicado', 'arquivado')),
  prazo_analise TEXT NOT NULL,             -- política interna
  analista_id INTEGER REFERENCES usuarios(id),
  analise TEXT,                            -- justificativa do arquivamento ou fundamentação da comunicação
  decidido_por INTEGER REFERENCES usuarios(id),
  decidido_em TEXT,
  prazo_comunicacao TEXT,                  -- 24 horas depois da decisão (art. 11, II)
  coaf_protocolo TEXT,
  comunicado_em TEXT,
  comunicado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX idx_pld_alertas_situacao ON pld_alertas(situacao, prazo_analise);
CREATE INDEX idx_pld_alertas_cliente ON pld_alertas(cliente_id);

-- Comunicação de não ocorrência (art. 11, III), uma por ano.
CREATE TABLE pld_declaracoes (
  ano INTEGER PRIMARY KEY,
  protocolo TEXT NOT NULL,
  enviado_em TEXT NOT NULL,
  registrado_por INTEGER REFERENCES usuarios(id),
  registrado_em TEXT NOT NULL
);

-- Conheça seu cliente (art. 10, I e paragrafo 1): sócios, representantes, situação na Receita, revisão.
ALTER TABLE clientes ADD COLUMN kyc_socios TEXT;
ALTER TABLE clientes ADD COLUMN kyc_representantes TEXT;
ALTER TABLE clientes ADD COLUMN kyc_situacao_receita TEXT;
ALTER TABLE clientes ADD COLUMN kyc_revisado_em TEXT;
ALTER TABLE clientes ADD COLUMN kyc_revisado_por INTEGER REFERENCES usuarios(id);

-- Suspensão de repasse por ordem legal: a única exceção ao repasse imediato.
ALTER TABLE clientes ADD COLUMN bloqueio_repasse TEXT;
ALTER TABLE clientes ADD COLUMN bloqueio_em TEXT;
ALTER TABLE clientes ADD COLUMN bloqueio_por INTEGER REFERENCES usuarios(id);
`,
  },
];

const agora = () => new Date().toISOString();

function migrar(db) {
  db.exec('CREATE TABLE IF NOT EXISTS migracoes (versao INTEGER PRIMARY KEY, nome TEXT NOT NULL, aplicada_em TEXT NOT NULL)');
  const aplicadas = new Set(db.prepare('SELECT versao FROM migracoes').all().map((m) => m.versao));
  const novas = [];
  for (const m of MIGRACOES) {
    if (aplicadas.has(m.versao)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO migracoes (versao, nome, aplicada_em) VALUES (?, ?, ?)').run(m.versao, m.nome, agora());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migração ${m.versao} (${m.nome}) falhou: ${err.message}`);
    }
    novas.push(`${m.versao}-${m.nome}`);
  }
  return novas;
}

/** Cria o administrador no primeiro start. */
function semear(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n) return;
  db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, senha_provisoria, criado_em) VALUES (?, ?, ?, ?, 1, ?)')
    .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), 'admin', agora());
  console.log(`[PAY AX] Administrador criado: ${config.admin.email}`);
}

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrar(db);
  semear(db);
  // Clientes cadastrados antes desta numeração recebem o número agora, na ordem de cadastro.
  const numerados = contaInterna.garantirTodos(db);
  if (numerados) console.log(`[PAY AX] Número de conta interna atribuído a ${numerados} cliente(s).`);
  return db;
}

/** Executa `fn` numa transação (sem aninhar: reaproveita a transação em curso). */
function transacao(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* já desfeita */ }
    throw err;
  }
}

module.exports = { abrir, migrar, transacao, agora, MIGRACOES };
