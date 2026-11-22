'use strict';

const { DatabaseSync } = require('node:sqlite');

/*
 * Cópia do banco para backup.
 *
 * `VACUUM INTO` em vez de `cp`: copiar o arquivo enquanto o sistema escreve produz um banco corrompido
 * — e isso só se descobre no dia da restauração, que é o pior dia possível para descobrir. O VACUUM lê
 * uma visão consistente mesmo com o sistema no ar, e ainda entrega o arquivo compactado.
 *
 * Depois de copiar, confere. Backup que não abre não é backup.
 *
 *   node copiar-banco.js <origem> <destino>
 */

const [origem, destino] = process.argv.slice(2);
if (!origem || !destino) {
  console.error('uso: node copiar-banco.js <origem> <destino>');
  process.exit(2);
}

// No SQLite, aspas duplas são nome de coluna; texto vai entre aspas simples, com a simples dobrada.
const comoTexto = (s) => `'${String(s).replace(/'/g, "''")}'`;

try {
  const db = new DatabaseSync(origem, { readOnly: true });
  db.exec(`VACUUM INTO ${comoTexto(destino)}`);
  db.close();

  const copia = new DatabaseSync(destino, { readOnly: true });
  const r = copia.prepare('PRAGMA integrity_check').get().integrity_check;
  const migracoes = copia.prepare('SELECT COUNT(*) AS n FROM schema_migracoes').get().n;
  copia.close();
  if (r !== 'ok') {
    console.error(`A cópia saiu corrompida: ${r}`);
    process.exit(1);
  }
  console.log(`banco copiado e conferido (${migracoes} migrações)`);
} catch (err) {
  console.error(`Falha ao copiar o banco: ${err.message}`);
  process.exit(1);
}
