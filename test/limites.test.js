'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('Limite diário pedido pelo cliente', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const cli = (await api.post('/clientes', { tipo: 'PF', nome: 'Ana Souza', documento: '529.982.247-25' })).dados;
  const conta = (await api.post('/contas', { cliente_id: cli.id, tipo: 'corrente', limite_centavos: 100_000 })).dados;
  const digitar = async (senha) => {
    const d = (await api.post('/ib/auth/teclado', {}, null)).dados;
    return { teclado_id: d.id, sequencia: [...senha].map((c) => d.teclas.findIndex((par) => par.includes(Number(c)))) };
  };
  const hab = await api.post(`/clientes/${cli.id}/internet-banking`);
  let tk = (await api.post('/ib/auth/login', { documento: '52998224725', ...(await digitar(hab.dados.senha_provisoria)) }, null)).dados.token;
  await api.req('POST', '/ib/auth/primeiro-acesso', { nova_senha: '730194', pin: '482913' }, tk);
  tk = (await api.post('/ib/auth/login', { documento: '52998224725', ...(await digitar('730194')) }, null)).dados.token;
  const ib = (m, c, b) => api.req(m, `/ib${c}`, b, tk);
  const pin = () => digitar('482913');

  await t.test('cliente vê todos os limites', async () => {
    const r = (await ib('GET', '/limites')).dados;
    assert.equal(r.diario.limite_centavos, 500_000);
    assert.equal(r.diario.prazo_horas, 24);
    assert.equal(r.contas[0].limite_centavos, 100_000);
    assert.equal(r.diario.pedido, null);
  });

  await t.test('redução vale na hora; aumento fica agendado para 24 horas', async () => {
    const red = await ib('POST', '/limites/diario', { valor_centavos: 300_000, pin: await pin() });
    assert.equal(red.status, 200, JSON.stringify(red.dados));
    assert.equal(red.dados.imediato, true);
    assert.equal(red.dados.limite_centavos, 300_000);
    const sem = await ib('POST', '/limites/diario', { valor_centavos: 900_000 });
    assert.notEqual(sem.status, 200);
    const aum = await ib('POST', '/limites/diario', { valor_centavos: 900_000, pin: await pin() });
    assert.equal(aum.dados.imediato, false);
    assert.equal(aum.dados.limite_centavos, 300_000);
    assert.equal(aum.dados.pedido.valor_novo_centavos, 900_000);
    assert.ok(aum.dados.pedido.segundos_restantes > 23 * 3600 && aum.dados.pedido.segundos_restantes <= 24 * 3600);
    assert.equal((await ib('POST', '/limites/diario', { valor_centavos: 800_000, pin: await pin() })).status, 409);
    assert.equal((await ib('POST', '/limites/diario', { valor_centavos: 999_999_999, pin: await pin() })).status, 422);
  });

  await t.test('equipe vê o pedido na conta e pode recusar; cliente pode cancelar', async () => {
    const h = (await api.get(`/contas/${conta.id}/historico`)).dados;
    assert.equal(h.limite_diario.pedido.valor_novo_centavos, 900_000);
    assert.equal(h.pedidos_limite.length, 2);
    const id = h.limite_diario.pedido.id;
    assert.equal((await api.post(`/contas/limites/pedidos/${id}/recusar`, {})).status, 422);
    assert.equal((await api.post(`/contas/limites/pedidos/${id}/recusar`, { motivo: 'Movimentação incompatível com a renda.' })).status, 200);
    assert.equal((await ib('GET', '/limites')).dados.pedidos[0].status, 'recusado');
    const novo = (await ib('POST', '/limites/diario', { valor_centavos: 600_000, pin: await pin() })).dados.pedido;
    assert.equal((await ib('POST', `/limites/pedidos/${novo.id}/cancelar`)).status, 200);
    assert.equal((await ib('GET', '/limites')).dados.diario.pedido, null);
  });

  await t.test('depois de 24 horas o aumento entra em vigor sozinho', async () => {
    const p = (await ib('POST', '/limites/diario', { valor_centavos: 700_000, pin: await pin() })).dados.pedido;
    api.db.prepare("UPDATE pedidos_limite SET efetiva_em = datetime('now', '-1 minute') WHERE id = ?").run(p.id);
    const r = (await ib('GET', '/limites')).dados;
    assert.equal(r.diario.limite_centavos, 700_000);
    assert.equal(r.diario.pedido, null);
    assert.equal(r.pedidos[0].status, 'efetivado');
  });
});
