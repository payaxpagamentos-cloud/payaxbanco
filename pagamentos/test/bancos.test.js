'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const bancos = require('../server/lib/bancos');

test('vários bancos: registro central e conta só em banco homologado', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();

  await t.test('a lista traz o Bradesco homologado e os demais em homologação', () => {
    const l = bancos.listar();
    assert.equal(l[0].codigo, '237');
    assert.equal(l[0].homologado, true);
    assert.ok(l.some((b) => b.codigo === '001' && !b.homologado));
    assert.throws(() => bancos.criarBanco({ banco: '341' }), /em homologação/);
    assert.throws(() => bancos.criarBanco({ banco: '999' }), /não está na lista/);
    assert.equal(bancos.criarBanco({ banco: '237' }).modo, 'simulador');
  });

  await t.test('conta bancária: escolhe o banco; banco em homologação é recusado', async () => {
    const base = { apelido: 'Conta', agencia: '1234', conta: '56789', cedente: '1234567', beneficiario_nome: 'PAY AX LTDA', beneficiario_documento: '12345678000195' };
    const r = await api.post('/api/contas', { ...base, banco: '341' }, tk.admin);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /Itaú Unibanco ainda está em homologação/);
    const ok = await api.post('/api/contas', { ...base, banco: '237' }, tk.admin);
    assert.equal(ok.status, 201, JSON.stringify(ok.dados));
    assert.equal(ok.dados.banco, '237');
    const lista = (await api.get('/api/contas', tk.admin)).dados;
    assert.ok(lista.bancos.length >= 5);
  });

  await t.test('o boleto é calculado pela regra do banco da conta', async () => {
    const conta = api.db.prepare('SELECT * FROM contas_bancarias LIMIT 1').get();
    const b = bancos.calcularBoleto(conta, { nossoNumero: '12345', valorCentavos: 10000, vencimento: '2026-12-20' });
    assert.equal(b.codigo_barras.slice(0, 3), '237');
    assert.equal(b.linha_digitavel.replace(/\D/g, '').length, 47);
  });
});
