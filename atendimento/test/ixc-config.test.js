'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { criarApp } = require('../server/app');

/**
 * Primeira gravação do IXC pela tela de Integrações: o formulário manda os campos como texto e sem
 * "recursos". Antes, isso dava "Erro interno do servidor" (valor indefinido no banco).
 */
test('salvar o IXC pela primeira vez, com o endereço copiado do navegador', async () => {
  const meta = h.fingirMeta();
  const { db, empresa } = h.criarAmbiente();
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/api`;
    const { token } = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'carlos@fibramais.com.br', senha: 'senha12345' }) })).json();
    const salvar = (corpo) => fetch(`${base}/empresas/${empresa.id}/ixc`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(corpo) });

    const r = await salvar({ ativo: true, url: 'https://sp.connectlinksp.com.br/adm.php', token: '12:abcdef1234567890', timeout_ms: '8000',
      confirmar_por: 'cpf3', max_tentativas: '3', desbloqueio_ativo: true, desbloqueio_limite: '1', desbloqueio_periodo_dias: '30',
      chamado_ativo: true, assunto_chamado_id: '', fila_financeira_id: '', fila_tecnica_id: '' });
    assert.equal(r.status, 200, await r.clone().text());
    const c = await r.json();
    assert.equal(c.url, 'https://sp.connectlinksp.com.br', 'o /adm.php sai sozinho');
    assert.equal(c.ativo, true);
    assert.equal(c.token_configurado, true);

    const ruim = await salvar({ token: 'sem-formato' });
    assert.equal(ruim.status, 422);
  } finally { meta.restaurar(); await new Promise((r) => servidor.close(r)); }
});

test('testar a ZOE antes de cadastrar o WhatsApp: usa um número interno que nunca envia', async () => {
  const empresasLib = require('../server/lib/empresas');
  const meta = h.fingirMeta();
  const { db } = h.criarAmbiente();
  const nova = empresasLib.criar(db, { nome: 'Provedor Novo' }, { comExemplos: false });
  empresasLib.criarUsuario(db, nova.id, { nome: 'Ana', email: 'ana@novo.com.br', perfil: 'cliente', senha: 'senha12345' });
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const sem = h.semIa();
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/api`;
    const { token } = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@novo.com.br', senha: 'senha12345' }) })).json();
    const chamar = (m, c, corpo) => fetch(`${base}/empresas/${nova.id}${c}`, { method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: corpo ? JSON.stringify(corpo) : undefined });

    const r = await chamar('POST', '/ia/testar', { texto: 'oi, quero a segunda via' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.ok((await r.json()).respostas.length >= 1, 'a ZOE respondeu');
    assert.equal((await chamar('POST', '/ia/testar', { texto: 'de novo' })).status, 200, 'o segundo teste reaproveita o número interno');

    const numeros = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').all(nova.id);
    assert.equal(numeros.length, 1);
    assert.equal(numeros[0].ativo, 0, 'desativado: o envio recusa');
    assert.equal((await (await chamar('GET', '/numeros')).json()).itens.length, 0, 'não aparece na lista de números');
    assert.equal(meta.enviadas.length, 0, 'nada foi para a Meta');
  } finally { sem.restaurar(); meta.restaurar(); await new Promise((r) => servidor.close(r)); }
});
