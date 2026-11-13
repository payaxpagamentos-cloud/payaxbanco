'use strict';

// Aplica as migrações pendentes sem iniciar o servidor (útil antes de uma atualização).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { migrar } = require('./db');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
const aplicadas = migrar(db);
console.log(aplicadas.length ? `Migrações aplicadas: ${aplicadas.join(', ')}` : 'Banco já está na versão mais recente.');
