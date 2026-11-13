'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Valores em centavos (inteiros), durações em segundos, tamanhos em bytes. Carimbos de tempo em ISO 8601 (UTC).
const SCHEMA = `
-- Terminação: rotas de saída para a operadora (troncos SIP), com o custo por minuto de cada tipo de destino.
CREATE TABLE IF NOT EXISTS troncos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  host TEXT NOT NULL,
  porta INTEGER NOT NULL DEFAULT 5060,
  usuario TEXT,
  senha TEXT,
  prefixo TEXT,
  canais INTEGER NOT NULL DEFAULT 30 CHECK (canais > 0),
  custo_fixo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_fixo_centavos >= 0),
  custo_movel_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_movel_centavos >= 0),
  custo_internacional_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_internacional_centavos >= 0),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

-- Empresas clientes. Limites: ramais, chamadas simultâneas, disco das gravações e recursos de voz (por mês).
-- Tarifas: preço por minuto cobrado da empresa em cada tipo de destino (cadência em configuracoes).
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  documento TEXT,
  tipo TEXT NOT NULL DEFAULT 'pabx' CHECK (tipo IN ('pabx','discador','callcenter')),
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','bloqueada','excluida')),
  email TEXT,
  telefone TEXT,
  limite_ramais INTEGER NOT NULL DEFAULT 10 CHECK (limite_ramais >= 0),
  limite_canais INTEGER NOT NULL DEFAULT 10 CHECK (limite_canais >= 0),
  disco_mb INTEGER NOT NULL DEFAULT 1024 CHECK (disco_mb >= 0),
  tts_limite INTEGER NOT NULL DEFAULT 0 CHECK (tts_limite >= 0),
  stt_limite INTEGER NOT NULL DEFAULT 0 CHECK (stt_limite >= 0),
  tarifa_fixo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (tarifa_fixo_centavos >= 0),
  tarifa_movel_centavos INTEGER NOT NULL DEFAULT 0 CHECK (tarifa_movel_centavos >= 0),
  tarifa_internacional_centavos INTEGER NOT NULL DEFAULT 0 CHECK (tarifa_internacional_centavos >= 0),
  tronco_id INTEGER REFERENCES troncos(id),
  gravar_chamadas INTEGER NOT NULL DEFAULT 1,
  motivo_bloqueio TEXT,
  criada_em TEXT NOT NULL
);

-- master e suporte: equipe da plataforma (empresa_id nulo). cliente (administrador) e supervisor (só consulta): da empresa.
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('master','suporte','cliente','supervisor')),
  empresa_id INTEGER REFERENCES empresas(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL,
  CHECK ((perfil IN ('master','suporte')) = (empresa_id IS NULL))
);

-- Pessoas / Ramais. A senha SIP é a que o telefone usa para se registrar na central telefônica.
CREATE TABLE IF NOT EXISTS ramais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  numero TEXT NOT NULL,
  nome TEXT NOT NULL,
  email TEXT,
  senha_sip TEXT NOT NULL,
  gravar INTEGER NOT NULL DEFAULT 1,
  ativo INTEGER NOT NULL DEFAULT 1,
  online INTEGER NOT NULL DEFAULT 0,
  registro_em TEXT,
  registro_ip TEXT,
  registro_agente TEXT,
  criado_em TEXT NOT NULL,
  UNIQUE (empresa_id, numero)
);

-- Filas de atendimento e URAs (Recursos PABX).
CREATE TABLE IF NOT EXISTS filas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  estrategia TEXT NOT NULL DEFAULT 'todos' CHECK (estrategia IN ('todos','sequencial','aleatorio','menos_chamadas')),
  espera_maxima_s INTEGER NOT NULL DEFAULT 120 CHECK (espera_maxima_s BETWEEN 10 AND 3600),
  criada_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fila_ramais (
  fila_id INTEGER NOT NULL REFERENCES filas(id) ON DELETE CASCADE,
  ramal_id INTEGER NOT NULL REFERENCES ramais(id) ON DELETE CASCADE,
  PRIMARY KEY (fila_id, ramal_id)
);
CREATE TABLE IF NOT EXISTS uras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  -- [{ "digito": "1", "destino_tipo": "ramal"|"fila"|"ura", "destino_id": 3 }]
  opcoes TEXT NOT NULL DEFAULT '[]',
  -- 'classica': fala a mensagem e espera a tecla, sempre igual.
  -- 'inteligente': consulta o IXC pelo número que ligou e abre pelo motivo mais provável
  --   daquela pessoa — bloqueado por atraso, fatura vencida, falha na região.
  tipo TEXT NOT NULL DEFAULT 'classica' CHECK (tipo IN ('classica','inteligente')),
  -- Situações ligadas e a fala de cada uma: { "bloqueado": { "ativa": 1, "fala": "..." }, ... }
  situacoes TEXT NOT NULL DEFAULT '{}',
  -- Para onde vai quem pede atendente, não escolhe nada ou erra demais.
  fila_padrao_id INTEGER REFERENCES filas(id) ON DELETE SET NULL,
  -- Tecla que sempre leva a uma pessoa. Nenhuma URA pode prender o cliente.
  tecla_atendente TEXT NOT NULL DEFAULT '0',
  -- Depois de N erros ou silêncios, transfere em vez de repetir o menu.
  max_tentativas INTEGER NOT NULL DEFAULT 3 CHECK (max_tentativas BETWEEN 1 AND 5),
  criada_em TEXT NOT NULL
);

-- Números entrantes (DIDs). Sem empresa: livre no estoque do master. O destino é para onde a chamada vai ao chegar.
CREATE TABLE IF NOT EXISTS numeros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  descricao TEXT,
  tronco_id INTEGER REFERENCES troncos(id),
  empresa_id INTEGER REFERENCES empresas(id),
  destino_tipo TEXT CHECK (destino_tipo IN ('ramal','fila','ura')),
  destino_id INTEGER,
  criado_em TEXT NOT NULL
);

-- CRM: contatos da empresa, ligados às chamadas pelo telefone.
CREATE TABLE IF NOT EXISTS contatos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,
  email TEXT,
  organizacao TEXT,
  observacoes TEXT,
  criado_em TEXT NOT NULL,
  UNIQUE (empresa_id, telefone)
);

-- Campanhas do discador: a lista de telefones e a fila que atende quem responde.
CREATE TABLE IF NOT EXISTS campanhas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  modo TEXT NOT NULL DEFAULT 'progressivo' CHECK (modo IN ('preditivo','progressivo','preview')),
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','ativa','pausada','encerrada')),
  fila_id INTEGER REFERENCES filas(id),
  canais INTEGER NOT NULL DEFAULT 1 CHECK (canais > 0),
  tentativas_max INTEGER NOT NULL DEFAULT 3 CHECK (tentativas_max BETWEEN 1 AND 10),
  criada_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campanha_contatos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
  nome TEXT,
  telefone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','discando','atendido','nao_atendido','ocupado','falha')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  ultima_tentativa TEXT,
  UNIQUE (campanha_id, telefone)
);
CREATE INDEX IF NOT EXISTS idx_campanha_contatos ON campanha_contatos(campanha_id, status);

-- Chamadas (CDR), registradas pela central telefônica pela API de integração. Em curso enquanto fim é nulo.
CREATE TABLE IF NOT EXISTS chamadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  uid TEXT NOT NULL,
  direcao TEXT NOT NULL CHECK (direcao IN ('entrada','saida','interna')),
  origem TEXT NOT NULL,
  destino TEXT NOT NULL,
  tipo_destino TEXT NOT NULL DEFAULT 'interno' CHECK (tipo_destino IN ('interno','fixo','movel','internacional')),
  ramal_id INTEGER REFERENCES ramais(id),
  numero_id INTEGER REFERENCES numeros(id),
  campanha_id INTEGER REFERENCES campanhas(id),
  campanha_contato_id INTEGER REFERENCES campanha_contatos(id),
  tronco_id INTEGER REFERENCES troncos(id),
  status TEXT NOT NULL DEFAULT 'em_curso' CHECK (status IN ('em_curso','atendida','nao_atendida','ocupado','falha')),
  inicio TEXT NOT NULL,
  atendida_em TEXT,
  fim TEXT,
  duracao_s INTEGER NOT NULL DEFAULT 0,
  tarifado_s INTEGER NOT NULL DEFAULT 0,
  custo_centavos INTEGER NOT NULL DEFAULT 0,
  gravacao_bytes INTEGER NOT NULL DEFAULT 0,
  UNIQUE (empresa_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_chamadas_empresa ON chamadas(empresa_id, inicio);
CREATE INDEX IF NOT EXISTS idx_chamadas_inicio ON chamadas(inicio);
CREATE INDEX IF NOT EXISTS idx_chamadas_em_curso ON chamadas(empresa_id) WHERE fim IS NULL;

-- Uso de texto para voz (TTS) e voz para texto (STT), informado pela central telefônica.
CREATE TABLE IF NOT EXISTS uso_recursos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  recurso TEXT NOT NULL CHECK (recurso IN ('tts','stt')),
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uso_recursos ON uso_recursos(empresa_id, recurso, criado_em);

-- Chaves da API de integração (uma empresa por chave). Só o hash fica guardado.
CREATE TABLE IF NOT EXISTS chaves_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  prefixo TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  criada_em TEXT NOT NULL,
  criada_por INTEGER REFERENCES usuarios(id),
  ultimo_uso TEXT,
  revogada_em TEXT
);

-- Segurança: endereços IP bloqueados pelo master (não acessam o painel nem a API).
CREATE TABLE IF NOT EXISTS ips_bloqueados (
  ip TEXT PRIMARY KEY,
  motivo TEXT,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);

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

-- ZOE: atendente virtual ligada ao IXC do provedor. Uma configuração por empresa; o token do IXC fica cifrado.
CREATE TABLE IF NOT EXISTS zoe_config (
  empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id),
  ativo INTEGER NOT NULL DEFAULT 0,
  ixc_url TEXT,
  ixc_token_cifrado TEXT,
  desbloqueio_ativo INTEGER NOT NULL DEFAULT 1,
  desbloqueio_limite INTEGER NOT NULL DEFAULT 1 CHECK (desbloqueio_limite BETWEEN 0 AND 10),
  desbloqueio_periodo_dias INTEGER NOT NULL DEFAULT 30 CHECK (desbloqueio_periodo_dias BETWEEN 1 AND 365),
  canal_email INTEGER NOT NULL DEFAULT 1,
  canal_sms INTEGER NOT NULL DEFAULT 1,
  canal_whatsapp INTEGER NOT NULL DEFAULT 0,
  whatsapp_webhook TEXT,
  fila_financeiro_id INTEGER REFERENCES filas(id) ON DELETE SET NULL,
  fila_suporte_id INTEGER REFERENCES filas(id) ON DELETE SET NULL,
  fila_comercial_id INTEGER REFERENCES filas(id) ON DELETE SET NULL,
  -- Alertas de rede (falha em massa, manutenção) vêm do ZOE Atende, que é onde a equipe os
  -- cadastra. Guardar uma cópia aqui criaria duas verdades sobre a mesma falha.
  alertas_url TEXT,
  alertas_chave_cifrada TEXT,
  atualizado_em TEXT NOT NULL
);

-- Uma linha por ligação atendida pela ZOE (uid da central telefônica). Guarda o id do cliente no IXC, não o CPF.
CREATE TABLE IF NOT EXISTS zoe_atendimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  uid TEXT NOT NULL,
  telefone TEXT,
  etapa TEXT NOT NULL DEFAULT 'identificar' CHECK (etapa IN ('identificar','documento','confirmar','menu','transferir','encerrado')),
  metodo_confirmacao TEXT CHECK (metodo_confirmacao IN ('cpf3','nascimento')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  cliente_id TEXT,
  cliente_nome TEXT,
  motivo TEXT CHECK (motivo IN ('financeiro','suporte','comercial','outro')),
  resultado TEXT NOT NULL DEFAULT 'em_curso' CHECK (resultado IN ('em_curso','resolvido','transferido','abandonado')),
  fila_id INTEGER REFERENCES filas(id) ON DELETE SET NULL,
  resumo TEXT,
  inicio TEXT NOT NULL,
  fim TEXT,
  UNIQUE (empresa_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_zoe_atendimentos ON zoe_atendimentos(empresa_id, inicio);

-- Tudo o que a ZOE fez em cada ligação (consulta, boleto, desbloqueio, transferência, erro do IXC).
CREATE TABLE IF NOT EXISTS zoe_acoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  atendimento_id INTEGER NOT NULL REFERENCES zoe_atendimentos(id),
  cliente_id TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('identificacao','confirmacao','faturas','boleto','desbloqueio','transferencia','erro')),
  sucesso INTEGER NOT NULL DEFAULT 1,
  detalhes TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zoe_acoes ON zoe_acoes(atendimento_id);
CREATE INDEX IF NOT EXISTS idx_zoe_acoes_cliente ON zoe_acoes(empresa_id, cliente_id, tipo, criado_em);
`;

const CONFIG_PADRAO = {
  nome_plataforma: 'ZOE PABX Inteligente',
  // Tarifação: cobra no mínimo `cadencia_inicial_s` e depois em blocos de `cadencia_s` (padrão 30/6).
  cadencia_inicial_s: '30',
  cadencia_s: '6',
  // Tarifas por minuto sugeridas para as empresas novas.
  tarifa_fixo_centavos: '8',
  tarifa_movel_centavos: '25',
  tarifa_internacional_centavos: '150',
  limite_ramais_padrao: '10',
  limite_canais_padrao: '10',
  disco_mb_padrao: '1024',
  // Chamadas em curso há mais tempo que isso são encerradas como falha (a central telefônica não avisou o fim).
  chamada_max_horas: '6',
  // Ramal sem novo registro há mais tempo que isso passa a contar como offline.
  registro_expira_min: '10',
};

const agora = () => new Date().toISOString();

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  // Migração: ramal usado pelo usuário no telefone do painel.
  if (!db.prepare('PRAGMA table_info(usuarios)').all().some((c) => c.name === 'ramal_id')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN ramal_id INTEGER REFERENCES ramais(id) ON DELETE SET NULL');
  }

  const cfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, val] of Object.entries(CONFIG_PADRAO)) cfg.run(k, val);
  // Instalações antigas com o nome padrão de antes passam a usar o nome novo (um nome escolhido no painel não muda).
  db.prepare("UPDATE configuracoes SET valor = ? WHERE chave = 'nome_plataforma' AND valor = 'PABX'").run(CONFIG_PADRAO.nome_plataforma);

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

/** Configurações: números, exceto o nome da plataforma. */
function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  return Object.fromEntries(Object.keys(CONFIG_PADRAO).map((k) => [k, k === 'nome_plataforma' ? c[k] : Number(c[k])]));
}

module.exports = { abrir, transacao, lerConfig, agora, CONFIG_PADRAO };
