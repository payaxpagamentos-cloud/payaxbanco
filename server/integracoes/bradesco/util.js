'use strict';

const crypto = require('node:crypto');
const { ErroNegocio } = require('../../lib/erros');

/** txid de cobrança: 26 a 35 caracteres alfanuméricos (regra do Banco Central). */
const gerarTxid = () => `PAYAX${crypto.randomUUID().replace(/-/g, '').slice(0, 27)}`;

/** Converte "123.45" (formato da API PIX) em centavos sem passar por ponto flutuante. */
function decimalParaCentavos(valor) {
  const s = String(valor ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new ErroNegocio(`Valor inválido recebido do banco: ${s}`, 502);
  const [inteiro, frac = ''] = s.split('.');
  return Number(inteiro) * 100 + Number(frac.padEnd(2, '0'));
}

const centavosParaDecimal = (c) => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;

/** Erro devolvido pelo Bradesco (ou pelo simulador), com mensagem para o usuário. */
class ErroBradesco extends ErroNegocio {
  constructor(mensagem, status = 502, detalhes) {
    super(mensagem, status, detalhes);
    this.bradesco = true;
  }
}

module.exports = { gerarTxid, decimalParaCentavos, centavosParaDecimal, ErroBradesco };
