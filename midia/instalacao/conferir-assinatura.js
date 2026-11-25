#!/usr/bin/env node
'use strict';

/**
 * Confere se o pacote de atualização é mesmo o nosso.
 *
 * Dentro do pacote vêm dois arquivos: instalacao/MANIFESTO (a lista de todos os arquivos com o resumo
 * de cada um) e instalacao/MANIFESTO.sig (a assinatura dessa lista). Aqui se confere, nesta ordem:
 *   1. a assinatura da lista, com a chave pública que JÁ ESTÁ no servidor (não a que veio no pacote);
 *   2. cada arquivo contra o resumo da lista;
 *   3. que não há arquivo a mais, nem atalho (symlink), fora da lista.
 * Qualquer diferença: recusa. Uso: conferir-assinatura.js <pasta do pacote> <chave pública>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const recusar = (motivo) => { console.error(`RECUSADO: ${motivo}`); process.exit(1); };
const [pasta, chave] = process.argv.slice(2);
if (!pasta || !chave) recusar('uso: conferir-assinatura.js <pasta> <chave pública>');

let manifesto;
let assinatura;
try {
  manifesto = fs.readFileSync(path.join(pasta, 'instalacao', 'MANIFESTO'));
  assinatura = Buffer.from(fs.readFileSync(path.join(pasta, 'instalacao', 'MANIFESTO.sig'), 'utf8').trim(), 'base64');
} catch { recusar('o pacote não tem assinatura.'); }

let publica;
try { publica = crypto.createPublicKey(fs.readFileSync(chave)); } catch { recusar('não consegui ler a chave pública do servidor.'); }
if (!crypto.verify(null, manifesto, publica, assinatura)) recusar('a assinatura não confere.');

const esperado = new Map();
for (const linha of manifesto.toString('utf8').split('\n')) {
  if (!linha) continue;
  const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(linha);
  if (!m || m[2].includes('..') || path.isAbsolute(m[2])) recusar('lista de arquivos inválida.');
  esperado.set(m[2], m[1]);
}

const FORA_DA_LISTA = new Set(['instalacao/MANIFESTO', 'instalacao/MANIFESTO.sig']);
let vistos = 0;
(function andar(dir, rel) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${item.name}` : item.name;
    const inteiro = path.join(dir, item.name);
    if (item.isSymbolicLink()) recusar(`atalho não permitido: ${r}`);
    if (item.isDirectory()) { andar(inteiro, r); continue; }
    if (!item.isFile()) recusar(`tipo de arquivo não permitido: ${r}`);
    if (FORA_DA_LISTA.has(r)) continue;
    const resumo = esperado.get(r);
    if (!resumo) recusar(`arquivo fora da lista: ${r}`);
    if (crypto.createHash('sha256').update(fs.readFileSync(inteiro)).digest('hex') !== resumo) recusar(`arquivo alterado: ${r}`);
    vistos++;
  }
})(pasta, '');
if (vistos !== esperado.size) recusar('faltam arquivos da lista.');
console.log(`Assinatura confere (${vistos} arquivos).`);
