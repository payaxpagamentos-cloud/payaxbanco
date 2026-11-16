'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');

test('preço simples: Tarifa Boleto e Tarifa Bolepix; o banco cobra X, a PAY AX vende por Y', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const hoje = dataLocal('America/Sao_Paulo');
  await api.conta(tk.admin, { custo_liquidacao: '0,90', custo_bolepix: '1,20' });
  // Exatamente o que a tela envia: só as duas tarifas.
  const p = await api.post('/api/contas/precos-padrao', { bolepix_proprio: '1', tarifa_fixa: 'R$ 1,99', bolepix_tarifa_fixa: 'R$ 2,49', vigencia_inicio: hoje }, tk.admin);
  assert.equal(p.status, 201, JSON.stringify(p.dados));
  const vig = (await api.get('/api/contas/precos-padrao', tk.admin)).dados.vigente;
  assert.equal(vig.tarifa_fixa_centavos, 199);
  assert.equal(vig.percentual_ppm, 0);
  assert.equal(vig.tarifa_emissao_centavos, 0);
  assert.equal(vig.tarifa_repasse_centavos, 0);
  assert.equal(vig.comissao_maxima_centavos, null);
  assert.equal(JSON.parse(vig.bolepix).tarifa_fixa_centavos, 249);

  const { cliente } = await api.cliente(tk.admin);
  const venc = somarDias(hoje, 5);
  const boleto = await api.boleto(tk.admin, cliente.id, { tipo: 'boleto', valor: '100,00', vencimento: venc });
  const bolepix = await api.boleto(tk.admin, cliente.id, { tipo: 'bolepix', valor: '100,00', vencimento: venc });
  for (const b of [boleto, bolepix]) {
    const r = await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: hoje, valor_pago: '100,00', meio: 'boleto' }, tk.financeiro);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
  }
  const linha = (id) => api.db.prepare(`SELECT b.custo_liquidacao_centavos AS custo, b.tarifa_emissao_centavos AS emissao,
      (SELECT -SUM(valor_centavos) FROM lancamentos WHERE boleto_id = b.id AND tipo = 'comissao') AS tarifa,
      (SELECT SUM(valor_centavos) FROM lancamentos WHERE boleto_id = b.id) AS liquido
    FROM boletos b WHERE b.id = ?`).get(id);
  const a = linha(boleto.id);
  const c = linha(bolepix.id);
  // Venda: R$ 1,99 no boleto e R$ 2,49 no Bolepix; o cliente fica com o resto.
  assert.deepEqual([a.tarifa, a.emissao, a.liquido], [199, 0, 9801]);
  assert.deepEqual([c.tarifa, c.emissao, c.liquido], [249, 0, 9751]);
  // Compra: o banco cobra R$ 0,90 por boleto e R$ 1,20 por Bolepix (congelado em cada título).
  assert.equal(a.custo, 90);
  assert.equal(c.custo, 120);
  // Sem tarifa própria do Bolepix na conta, vale a do boleto.
  const conta = api.db.prepare('SELECT id, versao FROM contas_bancarias LIMIT 1').get();
  assert.equal((await api.patch(`/api/contas/${conta.id}`, { custo_bolepix: '', versao: conta.versao }, tk.admin)).status, 200);
  const outro = await api.boleto(tk.admin, cliente.id, { tipo: 'bolepix', valor: '50,00', vencimento: venc });
  assert.equal(api.db.prepare('SELECT custo_liquidacao_centavos AS c FROM boletos WHERE id = ?').get(outro.id).c, 90);
});
