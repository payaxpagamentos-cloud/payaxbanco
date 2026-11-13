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
