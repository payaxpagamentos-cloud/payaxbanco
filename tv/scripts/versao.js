#!/usr/bin/env node
'use strict';

/**
 * Carimba a versão no pacote (versao.json), para o painel mostrar o que está instalado e para
 * dar para conferir se uma atualização realmente entrou.
 *
 *   node scripts/versao.js              # carimba com a data de hoje
 *   node scripts/versao.js 2026.11.26   # carimba com uma versão escolhida
 *
 * O formato é a data da montagem (ano.mês.dia) mais um sufixo quando há mais de um pacote no
 * mesmo dia, que é o caso comum numa rodada de ajustes.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const destino = path.join(raiz, 'versao.json');

const hoje = new Date();
const data = [hoje.getFullYear(), hoje.getMonth() + 1, hoje.getDate()]
  .map((n, i) => (i ? String(n).padStart(2, '0') : n)).join('.');

const anterior = (() => {
  try { return JSON.parse(fs.readFileSync(destino, 'utf8')); } catch { return null; }
})();

/** Mesma data de novo: vira 2026.11.26-2, -3... para as versões do dia não se confundirem. */
function proximaDoDia() {
  if (!anterior?.versao?.startsWith(data)) return data;
  const sufixo = Number(anterior.versao.split('-')[1] ?? 1);
  return `${data}-${sufixo + 1}`;
}

const commit = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: raiz }).toString().trim(); } catch { return null; }
})();

const versao = { versao: process.argv[2] || proximaDoDia(), gerado_em: hoje.toISOString(), commit };
fs.writeFileSync(destino, `${JSON.stringify(versao, null, 2)}\n`);
console.log(`versao.json: ${versao.versao}${commit ? ` (${commit})` : ''}`);
