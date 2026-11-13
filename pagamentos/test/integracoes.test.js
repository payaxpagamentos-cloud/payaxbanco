'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { criarIxcFalso } = require('./ixc-falso');
const { lerAviso } = require('../server/routes/publico');

test('webhook do banco: liquida, não duplica e guarda tudo', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin, { retencao_dias: 0 });
  const token = await api.tokenWebhook(tk.admin);

  await t.test('token errado é recusado', async () => {
    const r = await api.post('/api/publico/webhook/token-invalido-123', { nossoNumero: '1' });
    assert.equal(r.status, 403);
  });

  await t.test('o aviso liquida o título e aplica o split', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { valor: '450,00', vencimento: '2026-12-20' });
    const r = await api.post(`/api/publico/webhook/${token}`, {
      evento: 'liquidacao', nossoNumero: b.nosso_numero, valorPago: '450,00', dataCredito: '20.12.2026',
    });
    assert.equal(r.status, 200);
    assert.equal(r.dados.processado, true);
    const d = (await api.get(`/api/boletos/${b.id}`, tk.admin)).dados;
    assert.equal(d.situacao, 'liquidado');
    assert.equal(d.pago_valor_centavos, 45000);
    assert.equal(d.pago_em, '2026-12-20');
    assert.equal(d.lancamentos.length, 3);
  });

  await t.test('o mesmo aviso repetido não credita de novo', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { valor: '100,00', vencimento: '2026-12-21' });
    const corpo = { evento: 'liquidacao', nossoNumero: b.nosso_numero, valorPago: '100,00', dataCredito: '2026-12-21' };
    await api.post(`/api/publico/webhook/${token}`, corpo);
    const dois = await api.post(`/api/publico/webhook/${token}`, corpo);
    assert.equal(dois.dados.processado, false);
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM lancamentos WHERE boleto_id = ?').get(b.id).n, 3);
    const eventos = api.db.prepare("SELECT resultado FROM eventos_banco WHERE nosso_numero = ? ORDER BY id").all(b.nosso_numero);
    assert.deepEqual(eventos.map((e) => e.resultado), ['liquidado', 'repetido']);
  });

  await t.test('aviso de título inexistente é guardado e ignorado sem quebrar', async () => {
    const r = await api.post(`/api/publico/webhook/${token}`, { evento: 'liquidacao', nossoNumero: '99999999999', valorPago: '10,00' });
    assert.equal(r.status, 200);
    assert.equal(r.dados.processado, false);
    const e = api.db.prepare("SELECT * FROM eventos_banco WHERE nosso_numero = '99999999999'").get();
    assert.equal(e.resultado, 'ignorado');
    assert.ok(e.payload.includes('99999999999'), 'o corpo do aviso fica guardado');
  });

  await t.test('a leitura do aviso aceita as variações de nome e formato', () => {
    assert.deepEqual(lerAviso({ nossoNumero: '00000000012', valorPago: '150,75', dataCredito: '15.12.2026' }),
      { nosso_numero: '00000000012', valor_centavos: 15075, pago_em: '2026-12-15', evento: 'liquidacao', meio: 'boleto' });
    assert.equal(lerAviso({ eNumeroTitulo: '12', vlPagoTitulo: '99.90', dtCreditoTitulo: '2026-12-15' }).valor_centavos, 9990);
    assert.equal(lerAviso({ nosso_numero: '12', valor: 15075 }).valor_centavos, 15075, 'aceita centavos inteiros');
  });

  await t.test('a conciliação mostra o que aconteceu com cada aviso', async () => {
    const c = (await api.get('/api/relatorios/conciliacao?de=2000-01-01&ate=2100-01-01', tk.financeiro)).dados;
    const por = Object.fromEntries(c.resumo.map((x) => [x.resultado, x.n]));
    assert.ok(por.liquidado >= 2);
    assert.ok(por.repetido >= 1);
    assert.ok(por.ignorado >= 1);
  });
});

test('IXC: importa títulos, emite boletos e dá baixa de volta', async (t) => {
  const api = await iniciar();
  const ixc = criarIxcFalso();
  const url = await ixc.iniciar();
  t.after(async () => { await api.fechar(); await ixc.fechar(); });

  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin, { retencao_dias: 0 });

  await t.test('configura e testa a conexão', async () => {
    const r = await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { url, token: '7:hash-de-teste', tipo_padrao: 'bolepix' }, tk.admin);
    assert.equal(r.status, 200);
    const teste = await api.post(`/api/integracoes/ixc/${a.cliente.id}/testar`, {}, tk.operacao);
    assert.equal(teste.status, 200);
    assert.equal(teste.dados.ok, true);
  });

  await t.test('importa só os títulos em aberto e com pagador identificado', async () => {
    const r = await api.post(`/api/integracoes/ixc/${a.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao);
    assert.equal(r.status, 200);
    assert.equal(r.dados.criados, 2, 'o título já recebido e o cliente sem CPF ficam de fora');
    assert.equal(r.dados.ignorados, 1, 'pagador sem CPF/CNPJ no IXC');

    const lista = (await api.get('/api/boletos?origem=ixc', tk.admin)).dados;
    assert.equal(lista.total, 2);
    assert.deepEqual(lista.itens.map((b) => b.seu_numero).sort(), ['NF-5001', 'NF-5002']);
    const um = lista.itens.find((b) => b.seu_numero === 'NF-5001');
    assert.equal(um.valor_centavos, 12990, 'valor do IXC em centavos, sem multiplicar por 100');
  });

  await t.test('importar de novo não duplica', async () => {
    const r = await api.post(`/api/integracoes/ixc/${a.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao);
    assert.equal(r.dados.criados, 0);
    assert.equal((await api.get('/api/boletos?origem=ixc', tk.admin)).dados.total, 2);
  });

  await t.test('a linha digitável é gravada de volta no título do IXC', async () => {
    const put = ixc.chamadas.filter((c) => c.metodo === 'PUT' && c.recurso === 'fn_areceber');
    assert.ok(put.length >= 2);
    assert.match(put[0].dados.linha_digitavel ?? '', /^\d{47}$/);
    assert.match(put[0].dados.nosso_numero ?? '', /^\d{11}-[0-9P]$/);
  });

  await t.test('ao liquidar, o IXC recebe a baixa com data e valor', async () => {
    const b = (await api.get('/api/boletos?origem=ixc', tk.admin)).dados.itens[0];
    const antes = ixc.chamadas.length;
    await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: '2026-12-15', valor_pago: '129,90' }, tk.financeiro);
    await new Promise((r) => setTimeout(r, 300));
    const baixa = ixc.chamadas.slice(antes).find((c) => c.metodo === 'PUT' && c.dados.status === 'R');
    assert.ok(baixa, 'o IXC foi avisado');
    assert.equal(baixa.dados.valor_recebido, '129.90');
    assert.equal(baixa.dados.data_recebimento, '2026-12-15');
    const s = api.db.prepare("SELECT * FROM sincronismos WHERE tipo = 'baixa' ORDER BY id DESC LIMIT 1").get();
    assert.equal(s.erros, 0);
  });

  await t.test('IXC fora do ar não derruba a emissão: o erro fica registrado', async () => {
    await ixc.fechar();
    const r = await api.post(`/api/integracoes/ixc/${a.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao);
    assert.equal(r.status, 200);
    assert.ok(r.dados.erros >= 1);
    const i = api.db.prepare("SELECT * FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(a.cliente.id);
    assert.equal(i.estado, 'falha');
    assert.ok(i.ultimo_erro);
  });
});
