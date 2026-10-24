'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Distâncias em metros, velocidades em km/h, tempos em segundos, valores em centavos (inteiros). Carimbos de tempo em ISO 8601 (UTC).
const SCHEMA = `
-- Empresas clientes (frotas ou pessoas físicas). Regras dos alertas: ignição, horário de uso e tempo sem comunicação.
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  documento TEXT,
  tipo TEXT NOT NULL DEFAULT 'frota' CHECK (tipo IN ('frota','pessoa','locadora')),
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','bloqueada','excluida')),
  email TEXT,
  telefone TEXT,
  limite_veiculos INTEGER NOT NULL DEFAULT 10 CHECK (limite_veiculos >= 0),
  mensalidade_centavos INTEGER NOT NULL DEFAULT 0 CHECK (mensalidade_centavos >= 0),
  alertar_ignicao INTEGER NOT NULL DEFAULT 0,
  -- Horário de uso permitido ('HH:MM'), nos dias da semana listados (0 = domingo). Sem horário: sem alerta de uso fora do horário.
  horario_inicio TEXT,
  horario_fim TEXT,
  dias_uso TEXT NOT NULL DEFAULT '0123456',
  -- Alerta quando o veículo fica tanto tempo sem comunicar (0 desliga).
  sem_comunicacao_min INTEGER NOT NULL DEFAULT 120 CHECK (sem_comunicacao_min >= 0),
  motivo_bloqueio TEXT,
  criada_em TEXT NOT NULL
);

-- master e suporte: equipe da plataforma (empresa_id nulo). cliente (administrador) e operador (monitora e trata alertas): da empresa.
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('master','suporte','cliente','operador')),
  empresa_id INTEGER REFERENCES empresas(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL,
  CHECK ((perfil IN ('master','suporte')) = (empresa_id IS NULL))
);

-- Equipamentos. Sem empresa: no estoque do master. O IMEI (ou o identificador do app) é como o equipamento se apresenta.
-- protocolo: gt06 (TCP), osmand (HTTP, app Traccar Client e compatíveis) ou api (enviado por outro sistema com a chave da empresa).
CREATE TABLE IF NOT EXISTS rastreadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imei TEXT NOT NULL UNIQUE,
  modelo TEXT,
  protocolo TEXT NOT NULL DEFAULT 'gt06' CHECK (protocolo IN ('gt06','osmand','api')),
  chip_numero TEXT,
  chip_operadora TEXT,
  empresa_id INTEGER REFERENCES empresas(id),
  observacoes TEXT,
  ultima_comunicacao TEXT,
  ultimo_ip TEXT,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS motoristas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  cpf TEXT,
  cnh TEXT,
  cnh_categoria TEXT,
  cnh_validade TEXT,
  telefone TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  UNIQUE (empresa_id, cpf)
);

-- Veículos, com a última posição recebida (para o mapa ao vivo) e o hodômetro e o horímetro calculados pelas posições.
CREATE TABLE IF NOT EXISTS veiculos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  placa TEXT NOT NULL,
  descricao TEXT,
  marca TEXT,
  modelo TEXT,
  cor TEXT,
  ano INTEGER,
  tipo TEXT NOT NULL DEFAULT 'carro' CHECK (tipo IN ('carro','moto','caminhao','van','onibus','maquina','outro')),
  rastreador_id INTEGER UNIQUE REFERENCES rastreadores(id),
  motorista_id INTEGER REFERENCES motoristas(id),
  limite_velocidade_kmh INTEGER NOT NULL DEFAULT 0 CHECK (limite_velocidade_kmh BETWEEN 0 AND 300),
  hodometro_m INTEGER NOT NULL DEFAULT 0 CHECK (hodometro_m >= 0),
  horimetro_s INTEGER NOT NULL DEFAULT 0 CHECK (horimetro_s >= 0),
  ativo INTEGER NOT NULL DEFAULT 1,
  bloqueado INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  velocidade_kmh REAL,
  curso INTEGER,
  ignicao INTEGER,
  tensao REAL,
  posicao_em TEXT,
  comunicacao_em TEXT,
  -- Estados dos alertas (para avisar uma vez por ocorrência).
  em_excesso INTEGER NOT NULL DEFAULT 0,
  fora_horario_alertado INTEGER NOT NULL DEFAULT 0,
  sem_comunicacao_alertado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL,
  UNIQUE (empresa_id, placa)
);

-- Histórico de posições. gps_em: hora da posição no equipamento; recebido_em: chegada ao servidor.
CREATE TABLE IF NOT EXISTS posicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  velocidade_kmh REAL NOT NULL DEFAULT 0,
  curso INTEGER,
  altitude REAL,
  satelites INTEGER,
  ignicao INTEGER,
  tensao REAL,
  evento TEXT,
  gps_em TEXT NOT NULL,
  recebido_em TEXT NOT NULL,
  UNIQUE (veiculo_id, gps_em)
);
CREATE INDEX IF NOT EXISTS idx_posicoes_gps ON posicoes(gps_em);

-- Uso por dia (no fuso configurado): quilômetros, tempo ligado e velocidade máxima, somados a cada posição.
CREATE TABLE IF NOT EXISTS uso_diario (
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  distancia_m INTEGER NOT NULL DEFAULT 0,
  ligado_s INTEGER NOT NULL DEFAULT 0,
  velocidade_max_kmh REAL NOT NULL DEFAULT 0,
  posicoes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (veiculo_id, data)
);

-- Cercas eletrônicas: círculo (centro e raio) ou polígono ([[lat, lng], ...]). Sem veículos escolhidos, valem para todos da empresa.
CREATE TABLE IF NOT EXISTS cercas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('circulo','poligono')),
  lat REAL,
  lng REAL,
  raio_m INTEGER,
  pontos TEXT,
  alertar_entrada INTEGER NOT NULL DEFAULT 1,
  alertar_saida INTEGER NOT NULL DEFAULT 1,
  cor TEXT NOT NULL DEFAULT '#1E88E5',
  ativa INTEGER NOT NULL DEFAULT 1,
  criada_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cerca_veiculos (
  cerca_id INTEGER NOT NULL REFERENCES cercas(id) ON DELETE CASCADE,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  PRIMARY KEY (cerca_id, veiculo_id)
);
CREATE TABLE IF NOT EXISTS cerca_estado (
  cerca_id INTEGER NOT NULL REFERENCES cercas(id) ON DELETE CASCADE,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  dentro INTEGER NOT NULL,
  desde TEXT NOT NULL,
  PRIMARY KEY (cerca_id, veiculo_id)
);

-- Alertas: velocidade, cercas, ignição, uso fora do horário, pânico, bateria e falta de comunicação.
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('velocidade','cerca_entrada','cerca_saida','ignicao_ligada','ignicao_desligada','fora_horario','panico',
    'bateria_desconectada','bateria_baixa','sem_comunicacao','violacao')),
  mensagem TEXT NOT NULL,
  lat REAL,
  lng REAL,
  velocidade_kmh REAL,
  ocorrido_em TEXT NOT NULL,
  tratado_em TEXT,
  tratado_por INTEGER REFERENCES usuarios(id),
  observacao TEXT
);
CREATE INDEX IF NOT EXISTS idx_alertas_empresa ON alertas(empresa_id, ocorrido_em);
CREATE INDEX IF NOT EXISTS idx_alertas_veiculo ON alertas(veiculo_id, ocorrido_em);
CREATE INDEX IF NOT EXISTS idx_alertas_pendentes ON alertas(empresa_id) WHERE tratado_em IS NULL;

-- Comandos para o equipamento (bloqueio, desbloqueio, localização, reinício ou texto livre).
CREATE TABLE IF NOT EXISTS comandos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  rastreador_id INTEGER NOT NULL REFERENCES rastreadores(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('bloquear','desbloquear','localizar','reiniciar','status','parametros','personalizado')),
  texto TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviado','confirmado','falhou','expirado','cancelado')),
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  enviado_em TEXT,
  respondido_em TEXT,
  resposta TEXT
);
CREATE INDEX IF NOT EXISTS idx_comandos_abertos ON comandos(rastreador_id) WHERE status IN ('pendente','enviado');

-- Plano de manutenção por veículo (a cada X km e/ou Y dias) e o histórico do que foi feito.
CREATE TABLE IF NOT EXISTS manutencoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  descricao TEXT NOT NULL,
  intervalo_km INTEGER CHECK (intervalo_km > 0),
  intervalo_dias INTEGER CHECK (intervalo_dias > 0),
  ultima_km INTEGER NOT NULL DEFAULT 0,
  ultima_data TEXT NOT NULL,
  criada_em TEXT NOT NULL,
  CHECK (intervalo_km IS NOT NULL OR intervalo_dias IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS manutencao_registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manutencao_id INTEGER REFERENCES manutencoes(id) ON DELETE SET NULL,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  descricao TEXT NOT NULL,
  data TEXT NOT NULL,
  km INTEGER NOT NULL,
  custo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_centavos >= 0),
  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);

-- Link público e temporário da localização de um veículo. Só o hash do código fica guardado.
CREATE TABLE IF NOT EXISTS compartilhamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE,
  expira_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  revogado_em TEXT
);

-- Equipamentos que se apresentaram sem estar cadastrados (para o master cadastrar).
CREATE TABLE IF NOT EXISTS desconhecidos (
  imei TEXT PRIMARY KEY,
  protocolo TEXT NOT NULL,
  ip TEXT,
  primeiro_contato TEXT NOT NULL,
  ultimo_contato TEXT NOT NULL,
  mensagens INTEGER NOT NULL DEFAULT 1
);

-- Mensagens recebidas por dia e protocolo (dashboard e diagnóstico).
CREATE TABLE IF NOT EXISTS recepcao_diaria (
  data TEXT NOT NULL,
  protocolo TEXT NOT NULL,
  mensagens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (data, protocolo)
);

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
  nome_plataforma: 'Rastreador',
  // Veículo que comunicou há até N minutos conta como online.
  online_min: '10',
  // Parado por N minutos (ou com a ignição desligada) encerra a viagem nos relatórios.
  parada_min: '5',
  // Posições mais antigas que isso são apagadas.
  retencao_dias: '180',
  // Salto entre duas posições acima desta velocidade é erro do GPS: a posição é descartada.
  velocidade_max_plausivel_kmh: '250',
  // Comandos não confirmados nesse prazo expiram.
  comando_expira_horas: '24',
  limite_veiculos_padrao: '10',
  mensalidade_padrao_centavos: '4990',
  sem_comunicacao_padrao_min: '120',
  // Textos enviados aos rastreadores GT06 (variam por fabricante: ex. DYD,000000# e HFYD,000000#).
  gt06_cmd_bloquear: 'RELAY,1#',
  gt06_cmd_desbloquear: 'RELAY,0#',
  gt06_cmd_localizar: 'WHERE#',
  gt06_cmd_reiniciar: 'RESET#',
};
const CONFIG_TEXTO = ['nome_plataforma', 'gt06_cmd_bloquear', 'gt06_cmd_desbloquear', 'gt06_cmd_localizar', 'gt06_cmd_reiniciar'];

const agora = () => new Date().toISOString();

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

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

/** Configurações: números, exceto os textos (nome da plataforma e comandos GT06). */
function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  return Object.fromEntries(Object.keys(CONFIG_PADRAO).map((k) => [k, CONFIG_TEXTO.includes(k) ? c[k] : Number(c[k])]));
}

module.exports = { abrir, transacao, lerConfig, agora, CONFIG_PADRAO, CONFIG_TEXTO };
