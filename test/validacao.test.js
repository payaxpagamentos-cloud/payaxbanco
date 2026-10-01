'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cpfValido, cnpjValido } = require('../server/lib/validacao');
const { digitoVerificador } = require('../server/lib/conta');
const { simular, parcelaPrice, somarMeses } = require('../server/lib/financeiro');

test('valida CPF e CNPJ', () => {
  assert.equal(cpfValido('529.982.247-25'), true);
  assert.equal(cpfValido('529.982.247-24'), false);
  assert.equal(cpfValido('111.111.111-11'), false);
  assert.equal(cnpjValido('11.222.333/0001-81'), true);
  assert.equal(cnpjValido('11.222.333/0001-82'), false);
});

test('dígito verificador módulo 11', () => {
  assert.match(digitoVerificador('100001'), /^[0-9X]$/);
  assert.equal(digitoVerificador('100001'), digitoVerificador('100001'));
});

test('Tabela Price fecha o saldo devedor em zero', () => {
  assert.equal(parcelaPrice(100000, 0.02, 12), 9456);
  const s = simular(1_000_000, 0.0199, 24, new Date('2026-01-31T12:00:00Z'));
  assert.equal(s.cronograma.length, 24);
  assert.equal(s.cronograma.at(-1).saldo_devedor_centavos, 0);
  assert.equal(s.total_centavos, s.cronograma.reduce((a, p) => a + p.valor_centavos, 0));
  assert.equal(s.cronograma[0].vencimento, '2026-02-28');
});

test('somarMeses ajusta fim de mês', () => {
  assert.equal(somarMeses(new Date('2026-01-31T00:00:00Z'), 1), '2026-02-28');
  assert.equal(somarMeses(new Date('2026-03-15T00:00:00Z'), 12), '2027-03-15');
});
