'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.PAYAX_ACESSO_HOSTS = 'acesso.payax.com.br';
process.env.PAYAX_SITE_HOSTS = 'payax.com.br';
const { iniciar } = require('./helpers');

function pedir(raiz, caminho, host, corpo) {
  const u = new URL(raiz);
  const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: caminho, method: dados ? 'POST' : 'GET',
      headers: { Host: host, ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, corpo: t, headers: res.headers }));
    });
    r.on('error', reject);
    r.end(dados);
  });
}

test('acesso.payax.com.br: só a ativação', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const h = 'acesso.payax.com.br';

  await t.test('a página e os arquivos dela abrem', async () => {
    const p = await pedir(api.raiz, '/', h);
    assert.equal(p.status, 200);
    assert.match(p.corpo, /Ative seu acesso/);
    assert.equal(p.headers['cache-control'], 'no-store');
    for (const a of ['/acesso/acesso.js', '/acesso/acesso.css', '/acesso/payax-logo.svg']) assert.equal((await pedir(api.raiz, a, h)).status, 200, a);
  });

  await t.test('a API de ativação responde; o resto do sistema não', async () => {
    const r = await pedir(api.raiz, '/api/publico/ativacao/consultar', h, { token: 'x'.repeat(43) });
    assert.equal(r.status, 404);
    assert.match(r.corpo, /inválido/);
    assert.equal((await pedir(api.raiz, '/api/painel', h)).status, 404);
    assert.equal((await pedir(api.raiz, '/js/app.js', h)).status, 404);
    assert.equal((await pedir(api.raiz, '/cliente/', h)).status, 404);
    assert.equal((await pedir(api.raiz, '/api/publico/abertura', h, {})).status, 404);
  });

  await t.test('no endereço do sistema a página fica em /ativar', async () => {
    const p = await pedir(api.raiz, '/ativar', 'pagamentos.payax.com.br');
    assert.equal(p.status, 200);
    assert.match(p.corpo, /Ative seu acesso/);
    assert.equal((await pedir(api.raiz, '/acesso/acesso.js', 'pagamentos.payax.com.br')).status, 200);
  });

  await t.test('o link gerado aponta para acesso.payax.com.br', () => {
    const ativacao = require('../server/lib/ativacao');
    assert.equal(ativacao.base(), 'https://acesso.payax.com.br/');
  });
});
