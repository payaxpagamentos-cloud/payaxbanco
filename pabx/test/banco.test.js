'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

process.env.NODE_ENV = 'test';
const { abrir } = require('../server/db');

/**
 * Banco criado por uma versão anterior (antes da URA inteligente, dos alertas de rede e do
 * telefone do painel): ao abrir, ganha as colunas novas sem perder nada do que já tinha.
 */
test('banco antigo ganha as colunas novas ao abrir', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'pabx-banco-'));
  const arquivo = path.join(pasta, 'antigo.db');
  const velho = new DatabaseSync(arquivo);
  velho.exec(`
    CREATE TABLE empresas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, criada_em TEXT NOT NULL);
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      senha_hash TEXT NOT NULL, perfil TEXT NOT NULL, empresa_id INTEGER, ativo INTEGER NOT NULL DEFAULT 1, ultimo_acesso TEXT, criado_em TEXT NOT NULL);
    CREATE TABLE uras (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, nome TEXT NOT NULL, mensagem TEXT NOT NULL,
      opcoes TEXT NOT NULL DEFAULT '[]', criada_em TEXT NOT NULL);
    CREATE TABLE zoe_config (empresa_id INTEGER PRIMARY KEY, ativo INTEGER NOT NULL DEFAULT 0, ixc_url TEXT, ixc_token_cifrado TEXT,
      atualizado_em TEXT NOT NULL);
    CREATE TABLE chamadas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, uid TEXT NOT NULL, direcao TEXT NOT NULL,
      origem TEXT NOT NULL, destino TEXT NOT NULL, ramal_id INTEGER, inicio TEXT NOT NULL, fim TEXT);
    INSERT INTO empresas (nome, criada_em) VALUES ('Provedor antigo', 'x');
    INSERT INTO uras (empresa_id, nome, mensagem, criada_em) VALUES (1, 'Menu', 'Olá', 'x');
    INSERT INTO zoe_config (empresa_id, ativo, atualizado_em) VALUES (1, 0, 'x');
  `);
  velho.close();

  const db = abrir(arquivo);
  const colunas = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['tipo', 'situacoes', 'fila_padrao_id', 'tecla_atendente', 'max_tentativas']) assert.ok(colunas('uras').includes(c), `uras.${c}`);
  for (const c of ['alertas_url', 'alertas_chave_cifrada', 'fila_financeiro_id']) assert.ok(colunas('zoe_config').includes(c), `zoe_config.${c}`);
  assert.ok(colunas('usuarios').includes('ramal_id'));
  // O que já existia continua lá, com o padrão das colunas novas.
  const u = db.prepare('SELECT * FROM uras WHERE id = 1').get();
  assert.equal(u.nome, 'Menu');
  assert.equal(u.tipo, 'classica');
  assert.equal(u.tecla_atendente, '0');
  assert.equal(u.max_tentativas, 3);
  // Os índices novos e a tabela nova também chegam.
  const indices = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((i) => i.name);
  for (const i of ['idx_chamadas_origem', 'idx_chamadas_destino', 'idx_chamadas_ramal']) assert.ok(indices.includes(i), i);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ura_ligacoes'").get());
  db.close();

  // Abrir de novo não tenta acrescentar nada.
  const deNovo = abrir(arquivo);
  assert.deepEqual(require('../server/db').atualizarEsquema(deNovo), []);
  deNovo.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

test('o histórico de um contato e a supervisão por ramal usam índice', () => {
  const db = abrir(':memory:');
  const plano = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  assert.match(plano('SELECT COUNT(*) FROM chamadas c WHERE c.empresa_id = 1 AND (c.origem = ? OR c.destino = ?)'), /idx_chamadas_origem|idx_chamadas_destino/);
  assert.match(plano('SELECT COUNT(*) FROM chamadas ch WHERE ch.ramal_id = 1 AND ch.inicio >= ?'), /idx_chamadas_ramal/);
});
