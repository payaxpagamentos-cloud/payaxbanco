'use strict';

/*
 * Boleto de verdade, gerado no portal do Bradesco (Net Empresa) da PAY AX em 29/10/2026, carteira 09:
 * o código de barras e a linha digitável calculados pelo sistema têm de ser idênticos aos do banco.
 * (Sem dados do pagador: só o que identifica a cobrança.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const febraban = require('../server/lib/febraban');

test('boleto real do Bradesco: o sistema calcula exatamente o mesmo código', () => {
  const r = febraban.boletoBradesco({ agencia: '2672', conta: '5049', carteira: '09', nossoNumero: '63020000002', valorCentavos: 1000, vencimento: '2026-11-03' });
  assert.equal(febraban.formatarLinha(r.linha_digitavel), '23792.67202 96302.000003 02000.504908 8 16190000001000');
  assert.equal(r.nosso_numero_dv, '8', 'nosso número 09/63/020000002-8');
  assert.deepEqual(febraban.lerCodigoBarras(r.codigo_barras), {
    banco: '237', vencimento: '2026-11-03', valor_centavos: 1000, agencia: '2672', carteira: '09', nosso_numero: '63020000002', conta: '0005049',
  });
});
