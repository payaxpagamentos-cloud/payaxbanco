'use strict';

/* Gera uma cópia consistente do banco (VACUUM INTO), mesmo com o sistema rodando. Mantém as últimas N cópias. */
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { gerarBackup, pasta, manter } = require('./lib/backup');

const db = new DatabaseSync(config.dbFile);
const r = gerarBackup(db);
try { db.prepare('INSERT INTO estado_sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run('ultimo_backup', new Date().toISOString()); } catch { /* banco ainda sem as tabelas novas */ }
db.close();
console.log(`[PAY AX] Backup gerado: ${pasta()}/${r.arquivo} (${(r.tamanho / 1024).toFixed(0)} KB). Mantidos: ${manter()}.`);
