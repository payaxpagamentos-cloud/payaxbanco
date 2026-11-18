'use strict';

/**
 * Guardas de produção: o servidor só sobe com configuração de verdade.
 * Cada caso roda num processo próprio, porque a conferência acontece ao carregar a configuração.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SEGREDO_BOM = 'c4f3-segredo-de-producao-com-tamanho-suficiente';
const SENHA_BOA = 'S3nhaForteDaOperacao';

/** Carrega a configuração num processo separado e devolve { ok, erro }. */
function carregar(ambiente) {
  const r = spawnSync(process.execPath, ['-e', "require('./server/config'); console.log('ok');"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', TV_SECRET: '', TV_ADMIN_SENHA: '', ...ambiente },
    encoding: 'utf8',
  });
  return { ok: r.status === 0, saida: `${r.stdout}${r.stderr}` };
}

test('produção sem TV_SECRET e TV_ADMIN_SENHA recusa subir', () => {
  const r = carregar({});
  assert.equal(r.ok, false);
  assert.match(r.saida, /configuração obrigatória/i);
});

test('produção com segredo curto recusa subir', () => {
  const r = carregar({ TV_SECRET: 'curto-demais', TV_ADMIN_SENHA: SENHA_BOA });
  assert.equal(r.ok, false);
  assert.match(r.saida, /pelo menos 32 caracteres/i);
});

test('produção com senha de operação curta recusa subir', () => {
  const r = carregar({ TV_SECRET: SEGREDO_BOM, TV_ADMIN_SENHA: 'curta' });
  assert.equal(r.ok, false);
  assert.match(r.saida, /pelo menos 12 caracteres/i);
});

test('produção com os valores de exemplo do .env recusa subir', () => {
  const r = carregar({
    TV_SECRET: 'troque-por-um-segredo-aleatorio-de-32-caracteres-ou-mais',
    TV_ADMIN_SENHA: 'troque-esta-senha',
  });
  assert.equal(r.ok, false);
  assert.match(r.saida, /valor de exemplo/i);
});

test('produção com segredo e senha de verdade sobe', () => {
  const r = carregar({ TV_SECRET: SEGREDO_BOM, TV_ADMIN_SENHA: SENHA_BOA });
  assert.equal(r.ok, true, r.saida);
});
