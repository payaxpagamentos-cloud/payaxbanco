'use strict';

/* Gera uma cópia consistente do banco (VACUUM INTO), mesmo com o sistema rodando. Mantém as últimas N cópias. */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const pasta = process.env.PAYAX_BACKUP_DIR || path.join(path.dirname(config.dbFile), 'backups');
const manter = Number(process.env.PAYAX_BACKUP_MANTER) || 14;
fs.mkdirSync(pasta, { recursive: true });

const carimbo = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const destino = path.join(pasta, `banqueiro-${carimbo}.db`);
const db = new DatabaseSync(config.dbFile);
db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
db.close();

const antigos = fs.readdirSync(pasta).filter((f) => /^banqueiro-.*\.db$/.test(f)).sort().reverse().slice(manter);
for (const f of antigos) fs.rmSync(path.join(pasta, f));
console.log(`[PAY AX] Backup gerado: ${destino} (${(fs.statSync(destino).size / 1024).toFixed(0)} KB). Mantidos: ${manter}.`);
