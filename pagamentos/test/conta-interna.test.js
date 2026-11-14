'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, CNPJ } = require('./helpers');
const ci = require('../server/lib/contaInterna');

test('conta interna: dígito verificador e formatação', async (t) => {
  await t.test('o dígito muda com a agência e com a conta', () => {
    assert.notEqual(ci.dv('001', '0001'), ci.dv('002', '0001'));
    assert.notEqual(ci.dv('001', '0001'), ci.dv('001', '0002'));
    for (let n = 1; n <= 500; n++) assert.match(ci.dv('001', String(n).padStart(4, '0')), /^\d$/);
  });

  await t.test('confere o número informado e recusa o dígito errado', () => {
    const d = ci.dv('001', '0042');
    assert.equal(ci.conferir('001', '0042', d), true);
    assert.equal(ci.conferir('001', '0042', (Number(d) + 1) % 10), false);
    // Erro clássico: trocar dois dígitos de lugar.
    assert.equal(ci.conferir('001', '0024', d), false);
  });

  await t.test('formatação para a tela', () => {
    assert.equal(ci.formatar('001', '0001', '3'), '0001-3', 'código do cliente, sem agência');
    assert.equal(ci.formatar(null, null, null), '—');
  });
});

test('conta interna: numeração sequencial dos clientes', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);

  const criar = async (razao, cnpj) => (await api.post('/api/clientes', { razao_social: razao, cnpj, situacao: 'ativo', pix_chave: cnpj }, tk.admin)).dados;

  let a; let b; let c;
  await t.test('cada cliente novo recebe o próximo código da sequência', async () => {
    a = await criar('Primeiro LTDA', CNPJ.alfa);
    b = await criar('Segundo LTDA', CNPJ.beta);
    c = await criar('Terceiro LTDA', '22233344000183');
    assert.deepEqual([a.agencia_interna, b.agencia_interna, c.agencia_interna], ['001', '001', '001']);
    assert.deepEqual([a.conta_interna, b.conta_interna, c.conta_interna], ['0001', '0002', '0003']);
    assert.equal(a.conta_interna_dv, ci.dv('001', '0001'));
  });

  await t.test('a ficha e a lista mostram o código pronto, sem agência', async () => {
    const ficha = (await api.get(`/api/clientes/${a.id}`, tk.admin)).dados;
    assert.equal(ficha.codigo_cliente, `0001-${a.conta_interna_dv}`);
    assert.equal(ficha.conta_payax, undefined, 'não existe mais "conta PAY AX"');
    const lista = (await api.get('/api/clientes', tk.admin)).dados;
    assert.ok(lista.itens.every((x) => /^\d{4,}-\d$/.test(x.codigo_cliente)));
  });

  await t.test('a busca encontra pelo código, com ou sem o dígito', async () => {
    const porNumero = (await api.get('/api/clientes?busca=0002', tk.admin)).dados;
    assert.equal(porNumero.total, 1);
    assert.equal(porNumero.itens[0].id, b.id);
    const comDigito = (await api.get(`/api/clientes?busca=0003-${c.conta_interna_dv}`, tk.admin)).dados;
    assert.equal(comDigito.itens[0].id, c.id);
    assert.equal(ci.clientePorNumero(api.db, `0003-${c.conta_interna_dv}`).id, c.id);
    assert.equal(ci.clientePorNumero(api.db, `0003-${(Number(c.conta_interna_dv) + 1) % 10}`), null, 'dígito errado não acha');
  });

  await t.test('o número não muda ao editar o cadastro', async () => {
    const antes = (await api.get(`/api/clientes/${a.id}`, tk.admin)).dados;
    await api.patch(`/api/clientes/${a.id}`, { razao_social: 'Primeiro Renomeado LTDA', versao: antes.versao }, tk.admin);
    const depois = (await api.get(`/api/clientes/${a.id}`, tk.admin)).dados;
    assert.equal(depois.codigo_cliente, antes.codigo_cliente);
  });

  await t.test('dois cadastros ao mesmo tempo não repetem o número', async () => {
    const [x, y] = await Promise.all([
      api.post('/api/clientes', { razao_social: 'Paralelo A', cnpj: '36602203000103', situacao: 'ativo' }, tk.admin),
      api.post('/api/clientes', { razao_social: 'Paralelo B', cnpj: '06990590000123', situacao: 'ativo' }, tk.admin),
    ]);
    assert.equal(x.status, 201);
    assert.equal(y.status, 201);
    assert.notEqual(x.dados.conta_interna, y.dados.conta_interna);
    const repetidos = api.db.prepare(`SELECT agencia_interna, conta_interna, COUNT(*) AS n FROM clientes
      GROUP BY agencia_interna, conta_interna HAVING n > 1`).all();
    assert.deepEqual(repetidos, [], 'nenhum número repetido');
  });

  await t.test('depois de 9999 a sequência segue, sem abrir "outra agência"', async () => {
    api.db.prepare("UPDATE contas_internas SET proxima = 9999 WHERE agencia = '001'").run();
    const ultimo4 = await criar('Nove Mil LTDA', '11444777000161');
    const cincoDigitos = await criar('Dez Mil LTDA', '33014556000196');
    assert.deepEqual([ultimo4.agencia_interna, ultimo4.conta_interna], ['001', '9999']);
    assert.deepEqual([cincoDigitos.agencia_interna, cincoDigitos.conta_interna], ['001', '10000']);
    const ficha = (await api.get(`/api/clientes/${cincoDigitos.id}`, tk.admin)).dados;
    assert.match(ficha.codigo_cliente, /^10000-\d$/);
  });

  await t.test('o cliente vê o próprio código na Área do Cliente, sem agência', async () => {
    const d = await api.cliente(tk.admin, { razao_social: 'Com Acesso LTDA', cnpj: '45543915000181' });
    const painel = (await api.get('/cliente/api/painel', d.token)).dados;
    assert.match(painel.cliente.codigo, /^\d{4,}-\d$/);
    assert.equal(painel.cliente.agencia, undefined, 'a Área do Cliente não mostra agência');
    const conta = (await api.get('/cliente/api/conta', d.token)).dados;
    assert.equal(conta.codigo, painel.cliente.codigo);
    assert.equal(conta.agencia, undefined);
    const cadastro = (await api.get('/cliente/api/cadastro', d.token)).dados;
    assert.equal(cadastro.codigo_cliente, painel.cliente.codigo);
  });

  await t.test('cliente cadastrado antes da numeração recebe número no start', () => {
    api.db.prepare(`INSERT INTO clientes (razao_social, cnpj, situacao, criado_em) VALUES ('Antigo LTDA', '07526557000100', 'ativo', datetime('now'))`).run();
    const antigo = api.db.prepare("SELECT * FROM clientes WHERE cnpj = '07526557000100'").get();
    assert.equal(antigo.agencia_interna, null);
    assert.equal(ci.garantirTodos(api.db), 1);
    const depois = api.db.prepare("SELECT * FROM clientes WHERE cnpj = '07526557000100'").get();
    assert.ok(depois.agencia_interna && depois.conta_interna);
    assert.equal(depois.conta_interna_dv, ci.dv(depois.agencia_interna, depois.conta_interna));
    assert.equal(ci.garantirTodos(api.db), 0, 'rodar de novo não renumera');
  });

  await t.test('a conta PAY AX não vaza para o boleto: lá vão a agência e a conta do banco', async () => {
    const b2 = await api.boleto(tk.admin, a.id, { valor: '100,00', vencimento: '2026-12-20' });
    const det = (await api.get(`/api/boletos/${b2.id}`, tk.admin)).dados;
    assert.equal(det.conta.agencia, '3391', 'a agência do boleto é a do Bradesco');
    assert.equal(det.codigo_barras.slice(19, 23), '3391');
    assert.ok(!det.codigo_barras.includes('0010001'), 'a conta interna não entra no código de barras');
  });
});
