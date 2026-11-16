'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');

test('limite mensal de emissão do cliente', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const { cliente } = await api.cliente(tk.admin, { limite_mensal: 'R$ 250,00' });
  assert.equal(api.db.prepare('SELECT limite_mensal_centavos AS l FROM clientes WHERE id = ?').get(cliente.id).l, 25000);
  const venc = somarDias(dataLocal('America/Sao_Paulo'), 10);

  await api.boleto(tk.admin, cliente.id, { valor: '100,00', vencimento: venc });
  await api.boleto(tk.admin, cliente.id, { valor: '150,00', vencimento: venc });
  const r = await api.post('/api/boletos', { cliente_id: cliente.id, tipo: 'bolepix', valor: '5,00', vencimento: venc,
    pagador_nome: 'Maria Souza', pagador_documento: '11144477735' }, tk.admin);
  assert.equal(r.status, 422);
  assert.match(r.dados.erro, /Limite mensal de emissão/);

  // Sem limite mensal (campo vazio), volta a emitir.
  const versao = api.db.prepare('SELECT versao FROM clientes WHERE id = ?').get(cliente.id).versao;
  assert.equal((await api.patch(`/api/clientes/${cliente.id}`, { limite_mensal: '', versao }, tk.admin)).status, 200);
  await api.boleto(tk.admin, cliente.id, { valor: '5,00', vencimento: venc });
});
