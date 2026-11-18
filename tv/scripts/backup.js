'use strict';

/**
 * Backup da PLAY TECH VIP: o banco e os arquivos de mídia.
 *
 *   node scripts/backup.js /caminho/do/backup        (guarda as 7 cópias mais recentes)
 *   node scripts/backup.js /caminho/do/backup --manter 14
 *   node scripts/backup.js /caminho/do/backup --sem-midia
 *
 * O banco sai por VACUUM INTO: é uma cópia consistente, feita com o servidor no ar.
 * A mídia é espelhada com rsync quando ele existe; sem rsync, é cópia simples.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const config = require('../server/config');

const args = process.argv.slice(2);
const destino = args.find((a) => !a.startsWith('--'));
const numero = (nome, padrao) => {
  const i = args.indexOf(nome);
  return i >= 0 ? Number(args[i + 1]) || padrao : padrao;
};
const manter = numero('--manter', 7);
const comMidia = !args.includes('--sem-midia');

if (!destino) {
  console.error('Informe a pasta do backup. Exemplo:\n  node scripts/backup.js /var/backups/playtechvip');
  process.exit(1);
}

const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const pasta = path.join(destino, `playtechvip-${carimbo}`);
fs.mkdirSync(pasta, { recursive: true });

// ---- banco
const arquivoBanco = path.join(pasta, 'tv.db');
const db = new DatabaseSync(config.dbFile, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${arquivoBanco.replace(/'/g, "''")}'`);
} finally {
  db.close();
}
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
console.log(`banco  : ${arquivoBanco} (${mb(fs.statSync(arquivoBanco).size)})`);

// ---- mídia
function tamanhoDaPasta(dir) {
  let total = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (item.isFile()) total += fs.statSync(path.join(item.parentPath ?? item.path, item.name)).size;
  }
  return total;
}

if (comMidia && fs.existsSync(config.midiaDir)) {
  const alvo = path.join(pasta, 'midia');
  fs.mkdirSync(alvo, { recursive: true });
  try {
    execFileSync('rsync', ['-a', '--delete', `${config.midiaDir}/`, `${alvo}/`], { stdio: 'inherit' });
  } catch {
    fs.cpSync(config.midiaDir, alvo, { recursive: true });
  }
  console.log(`mídia  : ${alvo} (${mb(tamanhoDaPasta(alvo))})`);
} else if (comMidia) {
  console.log('mídia  : pasta não encontrada, nada copiado');
}

// ---- limpeza das cópias antigas
const copias = fs.readdirSync(destino)
  .filter((n) => n.startsWith('playtechvip-'))
  .sort()
  .reverse();
for (const velha of copias.slice(manter)) {
  fs.rmSync(path.join(destino, velha), { recursive: true, force: true });
  console.log(`apagado: ${velha}`);
}

console.log(`\nPronto. ${Math.min(copias.length, manter)} cópia(s) guardada(s) em ${destino}.`);
console.log('Para restaurar: pare o servidor, ponha tv.db e a pasta midia no lugar de data/ e suba de novo.');
