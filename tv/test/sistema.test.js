'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { iniciar } = require('./helpers');

/** Pasta compartilhada do agente, trocada por uma temporária durante o teste. */
function pastaDeTeste(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-atualizacao-'));
  const antes = process.env.TV_ATUALIZACAO;
  process.env.TV_ATUALIZACAO = p;
  t.after(() => {
    fs.rmSync(p, { recursive: true, force: true });
    if (antes === undefined) delete process.env.TV_ATUALIZACAO; else process.env.TV_ATUALIZACAO = antes;
  });
  return p;
}

test('o painel mostra a versão instalada e o estado da atualização', async (t) => {
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const r = await s.get('/admin/sistema', admin);
  assert.equal(r.status, 200);
  assert.ok(r.dados.versao.versao, 'a versão vem do versao.json do pacote');
  assert.equal(r.dados.agente, true, 'a pasta compartilhada existe, então o agente está no lugar');
  assert.equal(r.dados.na_fila, null);
  assert.ok(fs.existsSync(pasta));

  // Curador não mexe no sistema; assinante muito menos.
  const curador = await s.assinante('curioso@exemplo.com.br');
  assert.equal((await s.get('/admin/sistema', curador.token)).status, 403);
});

test('o pacote enviado fica na pasta do agente, com o pedido marcado', async (t) => {
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  // Conteúdo aleatório: não comprime, então o gzip fica do tamanho de um pacote de verdade.
  const pacote = zlib.gzipSync(crypto.randomBytes(64 * 1024));
  const r = await s.req('POST', '/admin/sistema/pacote', pacote, admin, { headers: { 'Content-Type': 'application/gzip' } });
  assert.equal(r.status, 202, JSON.stringify(r.dados));
  assert.equal(r.dados.pedido.bytes, pacote.length);

  assert.ok(fs.existsSync(path.join(pasta, 'pacote.tar.gz')), 'o pacote foi gravado para o agente pegar');
  const pedido = JSON.parse(fs.readFileSync(path.join(pasta, 'pedido.json'), 'utf8'));
  assert.equal(pedido.por, 'admin@playtechvip.com.br', 'fica registrado quem pediu');
  assert.equal(pedido.sha256.length, 64);

  const estado = await s.get('/admin/sistema', admin);
  assert.ok(estado.dados.na_fila, 'o painel passa a mostrar que há um pacote esperando');
});

test('arquivo que não é um pacote é recusado antes de chegar ao agente', async (t) => {
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  // Um PDF, uma foto, o arquivo errado do celular: nada disso pode virar pedido de atualização.
  const naoEhGzip = Buffer.alloc(4096, 0x41);
  const r = await s.req('POST', '/admin/sistema/pacote', naoEhGzip, admin, { headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 400);
  assert.match(r.dados.erro, /pacote/i);
  assert.equal(fs.existsSync(path.join(pasta, 'pedido.json')), false, 'nada foi pedido ao agente');

  const vazio = Buffer.alloc(10);
  assert.equal((await s.req('POST', '/admin/sistema/pacote', vazio, admin, { headers: { 'Content-Type': 'application/gzip' } })).status, 400);
});
