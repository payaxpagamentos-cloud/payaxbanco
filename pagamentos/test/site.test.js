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
    assert.match(r.corpo, /href="\/abrir-conta"/, 'botão Abra sua conta');
    assert.match(r.corpo, /\/site\/config\.js/, 'o login liga no sistema pelo config.js');
    for (const arq of ['/site/site.js', '/site/config.js', '/site/styles.css', '/site/assets/payax-logo.svg', '/site/assets/globo-poster.jpg',
      '/site/assets/integracoes.jpg', '/site/assets/globo-loop.mp4']) {
      assert.equal((await pegar(api.raiz, arq, 'www.payax.com.br')).status, 200, arq);
    }
  });

  await t.test('o site não carrega nada de fora (a política de segurança bloquearia)', async () => {
    const r = await pegar(api.raiz, '/', 'payax.com.br');
    const css = await pegar(api.raiz, '/site/styles.css', 'payax.com.br');
    assert.doesNotMatch(r.corpo, /(src|href)="(https?:)?\/\//);
    assert.doesNotMatch(r.corpo, /<script(?![^>]*\ssrc=)/, 'sem script embutido');
    assert.doesNotMatch(css.corpo, /url\((["']?)(https?:)?\/\//);
  });

  await t.test('no domínio do site, a Área do Cliente e a privacidade funcionam; o Backoffice não', async () => {
    assert.equal((await pegar(api.raiz, '/cliente/', 'payax.com.br')).status, 200);
    assert.equal((await pegar(api.raiz, '/privacidade', 'payax.com.br')).status, 200);
    assert.equal((await pegar(api.raiz, '/comum/marca.js', 'payax.com.br')).status, 200);
    assert.equal((await pegar(api.raiz, '/js/app.js', 'payax.com.br')).status, 404);
    assert.equal((await pegar(api.raiz, '/api/painel', 'payax.com.br')).status, 404);
  });

  await t.test('ícone da PAY AX para a Tela de Início do celular, em todos os endereços', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const bruto = (caminho, host) => new Promise((resolve, reject) => {
      const u = new URL(api.raiz);
      http.get({ hostname: u.hostname, port: u.port, path: caminho, headers: { Host: host } }, (res) => {
        const partes = []; res.on('data', (c) => partes.push(c));
        res.on('end', () => resolve({ status: res.statusCode, tipo: res.headers['content-type'], dados: Buffer.concat(partes) }));
      }).on('error', reject);
    });
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const lado = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];

    // O iPhone só usa PNG: sem a declaração (ou o arquivo na raiz), mostra uma letra no lugar do ícone.
    for (const pagina of ['/', '/abrir-conta', '/cliente/']) {
      const html = (await pegar(api.raiz, pagina, 'payax.com.br')).corpo;
      const m = html.match(/<link rel="apple-touch-icon" sizes="180x180" href="([^"]+)">/);
      assert.ok(m, `${pagina} declara o ícone`);
      const icone = await bruto(new URL(m[1], `http://payax.com.br${pagina}`).pathname, 'payax.com.br');
      assert.equal(icone.status, 200, `${pagina}: ${m[1]}`);
      assert.match(icone.tipo, /^image\/png/);
      assert.deepEqual(lado(icone.dados), [180, 180]);
      assert.equal(icone.dados[25], 2, 'sem transparência: o iPhone pintaria o fundo de preto');
      assert.match(html, /<meta name="apple-mobile-web-app-title" content="PAY AX">/, 'nome sugerido para o ícone');
    }
    for (const host of ['payax.com.br', 'www.payax.com.br', 'pagamentos.payax.com.br']) {
      for (const caminho of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
        const r = await bruto(caminho, host);
        assert.equal(r.status, 200, `${host}${caminho}`);
        assert.ok(r.dados.subarray(0, 4).equals(PNG));
      }
      const ico = await bruto('/favicon.ico', host);
      assert.equal(ico.status, 200, `${host}/favicon.ico`);
      assert.deepEqual([...ico.dados.subarray(0, 4)], [0, 0, 1, 0]);
    }

    // Manifesto (Android e "app web"): nome, início e ícones que existem, do tamanho que dizem ter.
    for (const [pagina, host, inicio] of [['/', 'payax.com.br', '/'], ['/cliente/', 'payax.com.br', '/cliente/'], ['/', 'pagamentos.payax.com.br', '/']]) {
      const html = (await pegar(api.raiz, pagina, host)).corpo;
      const m = html.match(/<link rel="manifest" href="([^"]+)">/);
      assert.ok(m, `${host}${pagina} declara o manifesto`);
      const endereco = new URL(m[1], `http://${host}${pagina}`);
      const r = await bruto(endereco.pathname, host);
      assert.equal(r.status, 200, endereco.pathname);
      assert.match(r.tipo, /^application\/manifest\+json/);
      const manifesto = JSON.parse(r.dados.toString('utf8'));
      assert.equal(manifesto.short_name, 'PAY AX');
      assert.equal(manifesto.display, 'standalone');
      assert.equal(new URL(manifesto.start_url, endereco).pathname, inicio);
      assert.ok(manifesto.icons.some((i) => i.purpose === 'maskable') && manifesto.icons.some((i) => i.sizes === '192x192') && manifesto.icons.some((i) => i.sizes === '512x512'));
      for (const i of manifesto.icons) {
        const png = await bruto(new URL(i.src, endereco).pathname, host);
        assert.equal(png.status, 200, `${host}: ${i.src}`);
        assert.equal(lado(png.dados).join('x'), i.sizes);
      }
    }
    // Os três manifestos apontam para os mesmos arquivos de ícone.
    assert.deepEqual(fs.readdirSync(path.join(__dirname, '..', 'comum', 'icones')).sort(),
      ['apple-touch-icon.png', 'favicon.ico', 'icone-192.png', 'icone-512.png', 'icone-mascara-512.png']);
  });

  await t.test('o domínio do sistema continua com o Backoffice', async () => {
    const r = await pegar(api.raiz, '/', 'pagamentos.payax.com.br');
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.corpo, /Uma nova perspectiva/);
  });
});
