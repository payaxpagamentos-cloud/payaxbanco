'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Valores em centavos (inteiros), distâncias em metros e durações em segundos. Carimbos de tempo em ISO 8601 (UTC).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  telefone TEXT,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','operador','motorista','passageiro')),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL
);

-- Cadastro do motorista: aprovado pela central antes de ficar online.
CREATE TABLE IF NOT EXISTS motoristas (
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),
  cpf TEXT NOT NULL UNIQUE,
  cnh TEXT NOT NULL UNIQUE,
  cnh_validade TEXT NOT NULL,
  chave_pix TEXT,
  situacao TEXT NOT NULL DEFAULT 'pendente' CHECK (situacao IN ('pendente','aprovado','recusado','bloqueado')),
  motivo TEXT,
  veiculo_id INTEGER REFERENCES veiculos(id),
  online INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  posicao_em TEXT,
  analisado_em TEXT,
  analisado_por INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS veiculos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  motorista_id INTEGER NOT NULL REFERENCES motoristas(usuario_id),
  placa TEXT NOT NULL UNIQUE,
  marca_modelo TEXT NOT NULL,
  cor TEXT NOT NULL,
  ano INTEGER NOT NULL,
  categoria TEXT NOT NULL CHECK (categoria IN ('comum','executivo')),
  situacao TEXT NOT NULL DEFAULT 'pendente' CHECK (situacao IN ('pendente','aprovado','recusado')),
  criado_em TEXT NOT NULL
);

-- Tarifa por categoria. Bandeira 2: à noite, aos domingos e feriados (horários em configuracoes).
CREATE TABLE IF NOT EXISTS tarifas (
  categoria TEXT PRIMARY KEY CHECK (categoria IN ('comum','executivo')),
  bandeirada_centavos INTEGER NOT NULL CHECK (bandeirada_centavos >= 0),
  km_centavos INTEGER NOT NULL CHECK (km_centavos >= 0),
  km_bandeira2_centavos INTEGER NOT NULL CHECK (km_bandeira2_centavos >= 0),
  minuto_centavos INTEGER NOT NULL CHECK (minuto_centavos >= 0),
  minima_centavos INTEGER NOT NULL CHECK (minima_centavos >= 0),
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corridas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passageiro_id INTEGER NOT NULL REFERENCES usuarios(id),
  motorista_id INTEGER REFERENCES motoristas(usuario_id),
  veiculo_id INTEGER REFERENCES veiculos(id),
  categoria TEXT NOT NULL CHECK (categoria IN ('comum','executivo')),
  origem_endereco TEXT NOT NULL,
  origem_lat REAL NOT NULL,
  origem_lng REAL NOT NULL,
  destino_endereco TEXT NOT NULL,
  destino_lat REAL NOT NULL,
  destino_lng REAL NOT NULL,
  distancia_estimada_m INTEGER NOT NULL,
  duracao_estimada_s INTEGER NOT NULL,
  bandeira INTEGER NOT NULL CHECK (bandeira IN (1,2)),
  valor_estimado_centavos INTEGER NOT NULL,
  forma_pagamento TEXT NOT NULL CHECK (forma_pagamento IN ('pix','cartao','dinheiro')),
  status TEXT NOT NULL DEFAULT 'solicitada'
    CHECK (status IN ('solicitada','aceita','chegou','em_andamento','finalizada','cancelada')),
  solicitada_em TEXT NOT NULL,
  aceita_em TEXT,
  chegou_em TEXT,
  iniciada_em TEXT,
  finalizada_em TEXT,
  cancelada_em TEXT,
  cancelada_por TEXT CHECK (cancelada_por IN ('passageiro','motorista','central','sistema')),
  motivo_cancelamento TEXT,
  -- Trajeto: a distância percorrida soma as posições enviadas pelo motorista durante a corrida.
  distancia_percorrida_m INTEGER NOT NULL DEFAULT 0,
  ultima_lat REAL,
  ultima_lng REAL,
  ultima_posicao_em TEXT,
  duracao_real_s INTEGER,
  valor_final_centavos INTEGER,
  taxa_plataforma_centavos INTEGER,
  valor_motorista_centavos INTEGER,
  pagamento_status TEXT NOT NULL DEFAULT 'pendente' CHECK (pagamento_status IN ('pendente','pago')),
  pago_em TEXT,
  pagamento_confirmado_por INTEGER REFERENCES usuarios(id),
  nota_do_passageiro INTEGER CHECK (nota_do_passageiro BETWEEN 1 AND 5),
  comentario_do_passageiro TEXT,
  nota_do_motorista INTEGER CHECK (nota_do_motorista BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_corridas_status ON corridas(status, solicitada_em);
CREATE INDEX IF NOT EXISTS idx_corridas_passageiro ON corridas(passageiro_id, id);
CREATE INDEX IF NOT EXISTS idx_corridas_motorista ON corridas(motorista_id, id);
CREATE INDEX IF NOT EXISTS idx_corridas_finalizada ON corridas(finalizada_em);

-- Motoristas que recusaram ou desistiram da corrida: ela não é oferecida de novo a eles.
CREATE TABLE IF NOT EXISTS recusas (
  corrida_id INTEGER NOT NULL REFERENCES corridas(id),
  motorista_id INTEGER NOT NULL REFERENCES motoristas(usuario_id),
  PRIMARY KEY (corrida_id, motorista_id)
);

-- Conta corrente do motorista com a plataforma. Saldo positivo: a plataforma deve repassar; negativo: o motorista deve taxas.
CREATE TABLE IF NOT EXISTS lancamentos_motorista (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  motorista_id INTEGER NOT NULL REFERENCES motoristas(usuario_id),
  corrida_id INTEGER REFERENCES corridas(id),
  repasse_id INTEGER REFERENCES repasses(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('corrida','taxa','repasse','estorno_repasse','ajuste')),
  descricao TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_lanc_motorista ON lancamentos_motorista(motorista_id, id);

CREATE TABLE IF NOT EXISTS repasses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  motorista_id INTEGER NOT NULL REFERENCES motoristas(usuario_id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  chave_pix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago','cancelado')),
  criado_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  concluido_em TEXT,
  concluido_por INTEGER REFERENCES usuarios(id),
  identificador TEXT,
  motivo TEXT
);
CREATE INDEX IF NOT EXISTS idx_repasses_status ON repasses(status, id);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
`;

const TARIFAS_PADRAO = [
  // categoria, bandeirada, km, km bandeira 2, minuto, mínima
  ['comum', 550, 375, 450, 50, 1000],
  ['executivo', 800, 520, 620, 70, 1800],
];

const CONFIG_PADRAO = {
  taxa_plataforma_bp: '1500', // 15,00% (em pontos-base)
  raio_busca_km: '5',
  expirar_solicitacao_min: '10',
  repasse_minimo_centavos: '2000',
  fator_rota: '1.3', // distância por ruas ≈ distância em linha reta × fator
  velocidade_media_kmh: '25',
  bandeira2_inicio_hora: '20',
  bandeira2_fim_hora: '6',
  bandeira2_domingo: '1',
  bandeira2_feriados: '1',
  pix_chave: '',
  pix_recebedor: 'APP TAXI',
  pix_cidade: 'SAO PAULO',
};

const agora = () => new Date().toISOString();

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const tarifa = db.prepare(`INSERT OR IGNORE INTO tarifas (categoria, bandeirada_centavos, km_centavos, km_bandeira2_centavos, minuto_centavos, minima_centavos, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const t of TARIFAS_PADRAO) tarifa.run(...t, agora());
  const cfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, val] of Object.entries(CONFIG_PADRAO)) cfg.run(k, val);

  const temAdmin = db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'admin' LIMIT 1").get();
  if (!temAdmin) {
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'admin', ?)")
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

/** Configurações como números (exceto as de texto do PIX). */
function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  const num = (k) => Number(c[k]);
  return {
    taxa_plataforma_bp: num('taxa_plataforma_bp'),
    raio_busca_km: num('raio_busca_km'),
    expirar_solicitacao_min: num('expirar_solicitacao_min'),
    repasse_minimo_centavos: num('repasse_minimo_centavos'),
    fator_rota: num('fator_rota'),
    velocidade_media_kmh: num('velocidade_media_kmh'),
    bandeira2_inicio_hora: num('bandeira2_inicio_hora'),
    bandeira2_fim_hora: num('bandeira2_fim_hora'),
    bandeira2_domingo: c.bandeira2_domingo === '1',
    bandeira2_feriados: c.bandeira2_feriados === '1',
    pix_chave: c.pix_chave,
    pix_recebedor: c.pix_recebedor,
    pix_cidade: c.pix_cidade,
  };
}

module.exports = { abrir, transacao, lerConfig, agora, CONFIG_PADRAO };
