'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { calcularSplit } = require('../server/lib/precos');
const { somarDiasUteis, ehDiaUtil } = require('../server/lib/datas');

test('split: o cálculo fecha sempre em inteiros', async (t) => {
  await t.test('bruto = tarifa + comissão + líquido', () => {
    for (const valor of [500, 999, 1234, 10000, 29990, 123456, 1000000]) {
      const r = calcularSplit({ valorPagoCentavos: valor, preco: { tarifa_liquidacao_centavos: 250, percentual_ppm: 23500, comissao_minima_centavos: 100, comissao_maxima_centavos: null } });
      assert.equal(r.tarifa_banco_centavos + r.comissao_centavos + r.liquido_centavos, valor, `falhou em ${valor}`);
      assert.ok(r.liquido_centavos >= 0);
    }
  });

  await t.test('piso e teto da comissão', () => {
    const preco = { tarifa_liquidacao_centavos: 0, percentual_ppm: 10000, comissao_minima_centavos: 500, comissao_maxima_centavos: 2000 };
    assert.equal(calcularSplit({ valorPagoCentavos: 1000, preco }).comissao_centavos, 500, 'piso');
    assert.equal(calcularSplit({ valorPagoCentavos: 1000000, preco }).comissao_centavos, 2000, 'teto');
    assert.equal(calcularSplit({ valorPagoCentavos: 100000, preco }).comissao_centavos, 1000, 'proporcional');
  });

  await t.test('título menor que a tarifa não deixa o cliente devendo', () => {
    const r = calcularSplit({ valorPagoCentavos: 150, preco: { tarifa_liquidacao_centavos: 250, percentual_ppm: 50000, comissao_minima_centavos: 300 } });
    assert.equal(r.liquido_centavos, 0);
    assert.equal(r.comissao_centavos, 0);
    assert.equal(r.tarifa_banco_centavos, 150);
  });

  await t.test('a margem desconta o custo real do banco', () => {
    const r = calcularSplit({ valorPagoCentavos: 10000, preco: { tarifa_liquidacao_centavos: 250, percentual_ppm: 20000, comissao_minima_centavos: 0 }, custoLiquidacaoCentavos: 190 });
    assert.equal(r.comissao_centavos, 200);
    assert.equal(r.receita_centavos, 450);
    assert.equal(r.margem_centavos, 260);
  });
});

test('liquidação: split na conta gráfica, retenção e idempotência', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin, { retencao_dias: 2 });

  const boleto = await api.boleto(tk.admin, a.cliente.id, { valor: '1.000,00', vencimento: '2026-12-10' });

  await t.test('o crédito entra retido e só depois fica disponível', async () => {
    const r = await api.post(`/api/boletos/${boleto.id}/liquidar`, { pago_em: '2026-12-10', valor_pago: '1.000,00' }, tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.bruto_centavos, 100000);
    assert.equal(r.dados.tarifa_banco_centavos, 250);
    assert.equal(r.dados.comissao_centavos, 2350);
    assert.equal(r.dados.liquido_centavos, 97400);
    assert.equal(r.dados.liberacao, somarDiasUteis('2026-12-10', 2));
    assert.ok(ehDiaUtil(r.dados.liberacao), 'a liberação cai em dia útil');

    const extrato = (await api.get(`/api/clientes/${a.cliente.id}/extrato?de=2026-12-01&ate=2026-12-31`, tk.admin)).dados;
    assert.deepEqual(extrato.itens.map((i) => i.tipo), ['credito_liquidacao', 'tarifa_banco', 'comissao']);
    assert.equal(extrato.itens.at(-1).saldo_acumulado_centavos, 97400);
  });

  await t.test('reprocessar a liquidação não duplica crédito', async () => {
    const r = await api.post(`/api/boletos/${boleto.id}/liquidar`, { pago_em: '2026-12-10', valor_pago: '1.000,00' }, tk.financeiro);
    assert.equal(r.dados.ja_liquidado, true);
    const lanc = api.db.prepare('SELECT COUNT(*) AS n FROM lancamentos WHERE boleto_id = ?').get(boleto.id).n;
    assert.equal(lanc, 3, 'continuam só os três lançamentos do split');
  });

  await t.test('estorno devolve exatamente o que foi lançado', async () => {
    const r = await api.post(`/api/boletos/${boleto.id}/estorno`, { motivo: 'devolução do pagador' }, tk.financeiro);
    assert.equal(r.status, 200);
    const soma = api.db.prepare('SELECT IFNULL(SUM(valor_centavos), 0) AS s FROM lancamentos WHERE cliente_id = ?').get(a.cliente.id).s;
    assert.equal(soma, 0, 'a conta gráfica volta a zero');
    const b = (await api.get(`/api/boletos/${boleto.id}`, tk.admin)).dados;
    assert.equal(b.situacao, 'registrado');
  });

  await t.test('o preço fica congelado na emissão', async () => {
    const antes = await api.boleto(tk.admin, a.cliente.id, { valor: '200,00', vencimento: '2026-12-15' });
    await api.post(`/api/clientes/${a.cliente.id}/precos`, { percentual: '10', tarifa_liquidacao: '9,90', comissao_minima: '0,00' }, tk.admin);
    const r = await api.post(`/api/boletos/${antes.id}/liquidar`, { pago_em: '2026-12-15', valor_pago: '200,00' }, tk.financeiro);
    assert.equal(r.dados.comissao_centavos, 470, 'usou os 2,35% da emissão, não os 10% novos');
    assert.equal(r.dados.tarifa_banco_centavos, 250);
    const depois = await api.boleto(tk.admin, a.cliente.id, { valor: '200,00', vencimento: '2026-12-16' });
    const d = (await api.get(`/api/boletos/${depois.id}`, tk.admin)).dados;
    assert.equal(d.percentual_ppm, 100000, 'o boleto novo já nasce com a tabela nova');
  });
});
