#!/usr/bin/env node
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
'use strict';

/**
 * Converte o banco de dados comum (sem criptografia) para criptografado (AES-256/SQLCipher), ou volta ao comum.
 *
 *   node scripts/cifrar-banco.js cifrar     — gera uma cópia criptografada com a RASTREADOR_DB_CHAVE do .env
 *   node scripts/cifrar-banco.js decifrar   — gera uma cópia sem criptografia (backup ou migração de volta)
 *
 * Gera "<banco>.novo"; o original não é tocado. Pare o sistema antes (pm2 stop rastreador) para o banco não estar em uso.
 * Depois de conferir, renomeie o .novo no lugar do banco (o comando certo aparece no fim).
 */
const fs = require('node:fs');
const path = require('node:path');
try { require('node:process').loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* sem .env: usa o ambiente */ }

let Database;
try { Database = require('better-sqlite3-multiple-ciphers'); }
catch { console.error('Driver de criptografia ausente. Rode "npm ci --omit=dev" na pasta do sistema e tente de novo.'); process.exit(1); }

const acao = process.argv[2];
const dbFile = process.env.RASTREADOR_DB || path.join(__dirname, '..', 'data', 'rastreador.db');
const chave = process.env.RASTREADOR_DB_CHAVE || '';

if (!['cifrar', 'decifrar'].includes(acao)) { console.error('Use: node scripts/cifrar-banco.js cifrar | decifrar'); process.exit(1); }
if (!chave) { console.error('Defina RASTREADOR_DB_CHAVE no .env (a chave da criptografia) antes de rodar.'); process.exit(1); }
if (!fs.existsSync(dbFile)) { console.error(`Banco não encontrado: ${dbFile}`); process.exit(1); }
for (const sufixo of ['-wal', '-shm']) {
  if (fs.existsSync(dbFile + sufixo)) { console.error(`Pare o sistema primeiro: existe ${path.basename(dbFile + sufixo)} (banco em uso).`); process.exit(1); }
}

const saida = `${dbFile}.novo`;
fs.rmSync(saida, { force: true });
fs.copyFileSync(dbFile, saida);
const db = new Database(saida);
try {
  db.pragma(`cipher='sqlcipher'`);
  const q = (c) => `'${String(c).replace(/'/g, "''")}'`;
  if (acao === 'cifrar') {
    db.pragma(`rekey=${q(chave)}`);
  } else {
    db.pragma(`key=${q(chave)}`);
    db.prepare('SELECT count(*) FROM sqlite_master').get(); // confere a chave
    db.pragma(`rekey=''`);
  }
  // Confere que o resultado abre e tem dados.
  const n = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n;
  db.close();
  console.log(`${acao === 'cifrar' ? 'Criptografado' : 'Sem criptografia'} gerado: ${saida} (${n} objetos).`);
  console.log('Confira e, com o sistema parado, renomeie no lugar:');
  console.log(`   mv ${dbFile} ${dbFile}.antigo && mv ${saida} ${dbFile}`);
} catch (err) {
  db.close();
  fs.rmSync(saida, { force: true });
  console.error('Falhou:', err.message);
  process.exit(1);
}
