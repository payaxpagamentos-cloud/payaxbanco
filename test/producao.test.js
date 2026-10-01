'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { limitar } = require('../server/lib/limitador');

test('limitador bloqueia acima do máximo por IP', () => {
  const mw = limitar({ janelaMs: 60_000, maximo: 3 });
  const res = { set() {} };
  const chamar = (ip) => { let erro; mw({ method: 'POST', ip }, res, (e) => { erro = e; }); return erro; };
  assert.equal(chamar('1.1.1.1'), undefined);
  assert.equal(chamar('1.1.1.1'), undefined);
  assert.equal(chamar('1.1.1.1'), undefined);
  assert.equal(chamar('1.1.1.1')?.status, 429);
  assert.equal(chamar('2.2.2.2'), undefined);
});

test('produção recusa iniciar sem segredos obrigatórios', () => {
  const r = spawnSync(process.execPath, ['-e', "require('./server/config')"], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production' }, encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PAYAX_SECRET, PAYAX_PEPPER, PAYAX_ADMIN_SENHA/);
  const ok = spawnSync(process.execPath, ['-e', "require('./server/config')"], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', PAYAX_SECRET: 'x'.repeat(40), PAYAX_PEPPER: 'p'.repeat(40), PAYAX_ADMIN_SENHA: 'senha-forte-123' }, encoding: 'utf8',
  });
  assert.equal(ok.status, 0, ok.stderr);
});
