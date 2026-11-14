'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { atualizarEsquema, colunasDoCreate, SCHEMA } = require('../server/db');

/** A instalação que já existe recebe as colunas e índices novos ao atualizar o sistema. */
test('banco de uma versão antiga ganha as colunas novas e o índice novo, e os dados ficam', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE empresas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, criada_em TEXT NOT NULL);
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL, perfil TEXT NOT NULL, empresa_id INTEGER, criado_em TEXT NOT NULL);
    CREATE TABLE conversas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, contato_id INTEGER NOT NULL,
      numero_id INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'bot', aberta_em TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_conversa_aberta ON conversas(contato_id) WHERE estado <> 'encerrada';
    INSERT INTO empresas (nome, criada_em) VALUES ('Antiga Net', '2026-01-01');`);
  const mudou = atualizarEsquema(db);
  assert.ok(mudou.includes('conversas.canal'));
  assert.ok(mudou.includes('usuarios.ramal'));
  assert.ok(mudou.includes('índice idx_conversa_aberta'));
  db.exec(SCHEMA);
  const indice = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_conversa_aberta'").get().sql;
  assert.match(indice, /contato_id, canal/);
  assert.equal(db.prepare("SELECT canal FROM conversas LIMIT 1").get(), undefined);
  assert.equal(db.prepare('SELECT nome FROM empresas').get().nome, 'Antiga Net');
  assert.deepEqual(atualizarEsquema(db), [], 'na segunda vez não há nada a fazer');
});

test('definições de coluna saem certas do CREATE, sem comentários e sem restrições da tabela', () => {
  const cols = colunasDoCreate(`CREATE TABLE x (
    id INTEGER PRIMARY KEY, -- comentário, com vírgula
    a TEXT NOT NULL DEFAULT 'b,c' CHECK (a IN ('b,c','d')),
    UNIQUE (a, id)
  )`);
  assert.deepEqual(cols, ['id INTEGER PRIMARY KEY', "a TEXT NOT NULL DEFAULT 'b,c' CHECK (a IN ('b,c','d'))"]);
});

test('número com o CHECK antigo: a tabela é refeita aceitando "zoe", sem perder dados nem as chamadas ligadas a ele', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA.replace("CHECK (destino_tipo IN ('ramal','fila','ura','zoe'))", "CHECK (destino_tipo IN ('ramal','fila','ura'))"));
  db.exec(`INSERT INTO empresas (nome, criada_em) VALUES ('Antiga Net', '2026-01-01');
    INSERT INTO pabx_numeros (numero, descricao, empresa_id, destino_tipo, destino_id, criado_em) VALUES ('1130001000', 'Principal', 1, 'fila', 3, '2026-01-01');
    INSERT INTO pabx_chamadas (empresa_id, uid, direcao, origem, destino, numero_id, inicio) VALUES (1, 'u1', 'entrada', '11999999999', '1001', 1, '2026-01-01');`);
  assert.throws(() => db.exec("UPDATE pabx_numeros SET destino_tipo = 'zoe' WHERE id = 1"), /CHECK/);
  const mudou = atualizarEsquema(db);
  assert.ok(mudou.includes('tabela pabx_numeros'));
  db.exec(SCHEMA);
  db.exec("UPDATE pabx_numeros SET destino_tipo = 'zoe', destino_id = NULL WHERE id = 1");
  const n = db.prepare('SELECT * FROM pabx_numeros WHERE id = 1').get();
  assert.equal(n.numero, '1130001000');
  assert.equal(n.descricao, 'Principal');
  assert.equal(db.prepare('SELECT numero_id FROM pabx_chamadas').get().numero_id, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'as chaves estrangeiras voltam ligadas');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_pabx_numeros%'").get() || true);
  assert.deepEqual(atualizarEsquema(db), [], 'na segunda vez não há nada a fazer');
});
