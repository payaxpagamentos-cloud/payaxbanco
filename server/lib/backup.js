'use strict';

/* Cópia consistente do banco (VACUUM INTO), mesmo com o sistema rodando. Mantém as últimas N cópias. Só roda no Node. */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const pasta = () => process.env.PAYAX_BACKUP_DIR || path.join(path.dirname(config.dbFile), 'backups');
const manter = () => Number(process.env.PAYAX_BACKUP_MANTER) || 14;

function gerarBackup(db) {
  if (config.dbFile === ':memory:') throw new Error('Banco em memória: não há arquivo para copiar.');
  const dir = pasta();
  fs.mkdirSync(dir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const destino = path.join(dir, `banqueiro-${carimbo}.db`);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const antigos = fs.readdirSync(dir).filter((f) => /^banqueiro-.*\.db$/.test(f)).sort().reverse().slice(manter());
  for (const f of antigos) fs.rmSync(path.join(dir, f));
  return { arquivo: path.basename(destino), tamanho: fs.statSync(destino).size };
}

module.exports = { gerarBackup, pasta, manter };
