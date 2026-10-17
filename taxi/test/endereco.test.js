'use strict';

// Publicação num caminho (ex.: https://dominio/taxi/), ao lado de outros sistemas no mesmo domínio.
process.env.TAXI_BASE_PATH = '/taxi';
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('app publicado em /taxi', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const ir = (p) => fetch(api.raiz + p, { redirect: 'manual' });
  assert.equal((await ir('/')).headers.get('location'), '/taxi/');
  assert.equal((await ir('/taxi')).headers.get('location'), '/taxi/');
  assert.equal((await ir('/taxi/motorista')).headers.get('location'), '/taxi/motorista/');
  for (const p of ['/taxi/', '/taxi/passageiro/', '/taxi/motorista/', '/taxi/central/', '/taxi/js/api.js', '/taxi/css/taxi.css', '/taxi/vendor/leaflet/leaflet.js']) {
    assert.equal((await ir(p)).status, 200, p);
  }
  assert.equal((await ir('/passageiro/')).status, 404);
  assert.equal((await api.get('/saude')).dados.ok, true);
  assert.ok(await api.login());
});
