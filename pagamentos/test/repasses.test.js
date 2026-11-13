'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { dataLocal } = require('../server/lib/datas');

const hoje = () => dataLocal('America/Sao_Paulo');

/** Liquida um boleto com crédito já liberado (retenção zero), para ter saldo disponível agora. */
async function creditar(api, tk, clienteId, valor) {
  const b = await api.boleto(tk.admin, clienteId, { valor, vencimento: hoje() });
  const r = await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: hoje(), valor_pago: valor }, tk.financeiro);
  return r.dados;
}

test('repasses: saldo, limite de aprovação, falha e rotina', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin, { tarifa_repasse: '1,00' });
  const a = await api.cliente(tk.admin, { retencao_dias: 0, repasse_limite_aprovacao: '500,00', repasse_automatico: false });

  await creditar(api, tk, a.cliente.id, '1.000,00');

  await t.test('o cliente vê quanto pode sacar e quanto recebe', async () => {
    const c = (await api.get('/cliente/api/conta', a.token)).dados;
    assert.equal(c.saldo.disponivel_centavos, 97400);
    assert.equal(c.disponivel.taxa_repasse_centavos, 100);
    assert.equal(c.disponivel.liquido_se_sacar_tudo_centavos, 97300);
  });

  await t.test('acima do limite do cliente, o repasse espera a nossa conferência', async () => {
    const r = await api.post('/cliente/api/repasses', { valor: 'tudo' }, a.token);
    assert.equal(r.status, 201);
    assert.equal(r.dados.situacao, 'aguardando_aprovacao');
    assert.equal(r.dados.valor_liquido_centavos, 97300);
    // O saldo já sai na solicitação: o dinheiro fica comprometido.
    const c = (await api.get('/cliente/api/conta', a.token)).dados;
    assert.equal(c.saldo.disponivel_centavos, 0);
    assert.equal(c.disponivel.em_transito_centavos, 97400);
  });

  await t.test('não dá para sacar mais do que o saldo', async () => {
    const r = await api.post('/cliente/api/repasses', { valor: '50,00' }, a.token);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /insuficiente/i);
  });

  await t.test('cancelar devolve tudo ao saldo, inclusive a tarifa', async () => {
    const pendente = (await api.get('/api/repasses?situacao=aguardando_aprovacao', tk.financeiro)).dados.itens[0];
    const r = await api.post(`/api/repasses/${pendente.id}/cancelar`, { motivo: 'cliente pediu para segurar' }, tk.financeiro);
    assert.equal(r.status, 200);
    const c = (await api.get('/cliente/api/conta', a.token)).dados;
    assert.equal(c.saldo.disponivel_centavos, 97400, 'voltou o valor cheio');
  });

  await t.test('aprovar e enviar confirma o PIX e guarda o end-to-end', async () => {
    const pedido = (await api.post('/cliente/api/repasses', { valor: 'tudo' }, a.token)).dados;
    assert.equal((await api.post(`/api/repasses/${pedido.id}/enviar`, {}, tk.financeiro)).status, 409, 'não envia sem aprovar');
    await api.post(`/api/repasses/${pedido.id}/aprovar`, {}, tk.financeiro);
    const enviado = await api.post(`/api/repasses/${pedido.id}/enviar`, {}, tk.financeiro);
    assert.equal(enviado.status, 200);
    assert.equal(enviado.dados.situacao, 'confirmado');
    assert.match(enviado.dados.end_to_end, /^E237/);
    const c = (await api.get('/cliente/api/conta', a.token)).dados;
    assert.equal(c.saldo.disponivel_centavos, 0);
  });

  await t.test('o extrato mostra o repasse e a tarifa separados', async () => {
    const e = (await api.get(`/cliente/api/conta/extrato?de=${hoje()}&ate=${hoje()}`, a.token)).dados;
    const tipos = e.itens.map((i) => i.tipo);
    assert.ok(tipos.includes('repasse'));
    assert.ok(tipos.includes('taxa_repasse'));
    assert.equal(e.itens.at(-1).saldo_acumulado_centavos, 0);
  });

  await t.test('cliente sem chave PIX não consegue sacar', async () => {
    const semPix = await api.cliente(tk.admin, { razao_social: 'Sem PIX LTDA', cnpj: '22233344000183', pix_chave: '', retencao_dias: 0 });
    await creditar(api, tk, semPix.cliente.id, '200,00');
    const r = await api.post('/cliente/api/repasses', { valor: 'tudo' }, semPix.token);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /chave PIX/i);
  });

  await t.test('rotina automática: dentro do limite envia sozinho, acima espera aprovação', async () => {
    const auto = await api.cliente(tk.admin, { razao_social: 'Auto LTDA', cnpj: '19131243000197', pix_chave: '19131243000197',
      retencao_dias: 0, repasse_automatico: true, repasse_minimo: '10,00', repasse_limite_aprovacao: '100.000,00' });
    const trava = await api.cliente(tk.admin, { razao_social: 'Trava LTDA', cnpj: '36602203000103', pix_chave: '36602203000103',
      retencao_dias: 0, repasse_automatico: true, repasse_minimo: '10,00', repasse_limite_aprovacao: '10,00' });
    await creditar(api, tk, auto.cliente.id, '300,00');
    await creditar(api, tk, trava.cliente.id, '300,00');

    const r = await api.post('/api/repasses/rotina', {}, tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.enviados, 1, 'só o que está dentro do limite foi enviado');
    assert.equal(r.dados.aguardando, 1, 'o outro ficou para conferência');
    assert.equal((await api.get('/cliente/api/conta', auto.token)).dados.saldo.disponivel_centavos, 0);
  });

  await t.test('a rotina ignora saldo abaixo do mínimo', async () => {
    const pequeno = await api.cliente(tk.admin, { razao_social: 'Pequeno LTDA', cnpj: '06990590000123', pix_chave: '06990590000123',
      retencao_dias: 0, repasse_automatico: true, repasse_minimo: '500,00', repasse_limite_aprovacao: '100.000,00' });
    await creditar(api, tk, pequeno.cliente.id, '50,00');
    const antes = (await api.get('/cliente/api/conta', pequeno.token)).dados.saldo.disponivel_centavos;
    await api.post('/api/repasses/rotina', {}, tk.financeiro);
    assert.equal((await api.get('/cliente/api/conta', pequeno.token)).dados.saldo.disponivel_centavos, antes, 'o saldo acumula para o próximo dia');
  });
});
