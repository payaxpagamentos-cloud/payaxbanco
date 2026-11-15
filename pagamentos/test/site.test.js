'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.PAYAX_SITE_HOSTS = 'payax.com.br,www.payax.com.br';
const { iniciar } = require('./helpers');

/** GET com o cabeçalho Host escolhido (o fetch não deixa trocar o Host). */
function pegar(raiz, caminho, host) {
  const u = new URL(raiz);
  return new Promise((resolve, reject) => {
    http.get({ hostname: u.hostname, port: u.port, path: caminho, headers: { Host: host } }, (res) => {
      let corpo = ''; res.on('data', (c) => { corpo += c; }); res.on('end', () => resolve({ status: res.statusCode, corpo }));
    }).on('error', reject);
  });
}

test('site público em payax.com.br', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());

  await t.test('payax.com.br mostra o site, com o acesso da Área do Cliente', async () => {
    const r = await pegar(api.raiz, '/', 'payax.com.br');
    assert.equal(r.status, 200);
    assert.match(r.corpo, /Uma nova perspectiva para/);
    assert.match(r.corpo, /Área do cliente/);
    assert.equal((await pegar(api.raiz, '/site/site.js', 'www.payax.com.br')).status, 200);
    assert.equal((await pegar(api.raiz, '/site/img/globo.jpg', 'payax.com.br')).status, 200);
  });

  await t.test('no domínio do site, a Área do Cliente e a privacidade funcionam; o Backoffice não', async () => {
    assert.equal((await pegar(api.raiz, '/cliente/', 'payax.com.br')).status, 200);
    assert.equal((await pegar(api.raiz, '/privacidade', 'payax.com.br')).status, 200);
    assert.equal((await pegar(api.raiz, '/comum/marca.js', 'payax.com.br')).status, 200);
    assert.equal((await pegar(api.raiz, '/js/app.js', 'payax.com.br')).status, 404);
    assert.equal((await pegar(api.raiz, '/api/painel', 'payax.com.br')).status, 404);
  });

  await t.test('o domínio do sistema continua com o Backoffice', async () => {
    const r = await pegar(api.raiz, '/', 'pagamentos.payax.com.br');
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.corpo, /Uma nova perspectiva/);
  });
});
