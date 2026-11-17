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
