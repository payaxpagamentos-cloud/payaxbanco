'use strict';

/** Monta um arquivo de retorno CNAB 400 do Bradesco, como o banco devolveria, para os testes. */
const cnab = require('../server/lib/cnab400');

const { texto, numero, valor, data, identificacaoEmpresa } = cnab;

function header(conta, { gerado_em, credito_em, sequencial = 1 }) {
  const l = '0' + '2' + 'RETORNO' + '01' + texto('COBRANCA', 15)
    + identificacaoEmpresa(conta, 20)
    + texto(conta.beneficiario_nome, 30)
    + '237' + texto('BRADESCO', 15)
    + data(gerado_em)
    + ' '.repeat(13) // 101-113
    + data(credito_em) // 114-119
    + ' '.repeat(271) // 120-390
    + numero(sequencial, 4) // 391-394
    + numero(1, 6); // 395-400
  if (l.length !== 400) throw new Error(`header do retorno com ${l.length} posições`);
  return l;
}

/**
 * @param {{nosso_numero, nosso_numero_dv, seu_numero, ocorrencia, ocorrido_em, vencimento,
 *          valor_centavos, pago_centavos, tarifa_centavos, juros_centavos, desconto_centavos,
 *          creditado_em, motivos}} r
 */
function detalhe(r, sequencial) {
  const partes = [
    '1', // 001
    '02', // 002-003
    numero('12345678000195', 14), // 004-017
    ' '.repeat(3), // 018-020
    '0'.repeat(17), // 021-037
    texto(r.seu_numero ?? '', 25), // 038-062
    ' '.repeat(8), // 063-070
    numero(r.nosso_numero, 11), // 071-081
    String(r.nosso_numero_dv ?? '0').slice(0, 1), // 082
    ' '.repeat(26), // 083-108
    String(r.ocorrencia).padStart(2, '0'), // 109-110
    data(r.ocorrido_em), // 111-116
    texto(r.seu_numero ?? '', 10), // 117-126
    numero(r.nosso_numero, 20), // 127-146
    data(r.vencimento), // 147-152
    valor(r.valor_centavos, 13), // 153-165
    '237', // 166-168
    '00000', // 169-173
    '01', // 174-175
    valor(r.tarifa_centavos ?? 0, 13), // 176-188
    valor(0, 13), // 189-201
    valor(0, 13), // 202-214
    valor(0, 13), // 215-227
    valor(0, 13), // 228-240
    valor(r.desconto_centavos ?? 0, 13), // 241-253
    valor(r.pago_centavos ?? 0, 13), // 254-266
    valor(r.juros_centavos ?? 0, 13), // 267-279
    valor(0, 13), // 280-292
    ' '.repeat(2), // 293-294
    ' ', // 295
    data(r.creditado_em), // 296-301
    ' '.repeat(17), // 302-318
    (r.motivos ?? []).map((m) => String(m).padStart(2, '0')).join('').padEnd(10, '0'), // 319-328
    ' '.repeat(66), // 329-394
    numero(sequencial, 6), // 395-400
  ];
  const l = partes.join('');
  if (l.length !== 400) throw new Error(`detalhe do retorno com ${l.length} posições`);
  return l;
}

/**
 * Registro 3 do retorno (rateio de crédito), como o banco devolve logo depois do título.
 * @param {{nosso_numero, nosso_numero_dv, valor_centavos?, motivo, credito_em?}} r  r.rateio = { valor_centavos, motivo, credito_em }
 */
function rateio(r, sequencial) {
  const x = r.rateio;
  const dataLonga = (iso) => (iso ? `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}` : '00000000');
  const l = [
    '3', // 001
    numero('0', 16), // 002-017
    numero(r.nosso_numero, 11) + String(r.nosso_numero_dv ?? '0').slice(0, 1), // 018-029
    '1', '1', // 030-031
    ' '.repeat(12), // 032-043
    '237', numero('1234', 5), '5', numero('98765', 12), '0', // 044-065
    valor(x.valor_centavos ?? 0, 15), // 066-080
    texto('CONNECT LINK TELECOM LTDA', 40), // 081-120
    ' '.repeat(21), // 121-141
    '000001', '000', // 142-150
    dataLonga(x.credito_em), // 151-158
    String(x.motivo).padStart(2, '0'), // 159-160
    ' '.repeat(234), // 161-394
    numero(sequencial, 6), // 395-400
  ].join('');
  if (l.length !== 400) throw new Error(`registro 3 do retorno com ${l.length} posições`);
  return l;
}

const trailer = (sequencial, { rateio_total_centavos = 0, rateio_quantidade = 0 } = {}) =>
  `9${' '.repeat(361)}${valor(rateio_total_centavos, 15)}${numero(rateio_quantidade, 8)}${' '.repeat(9)}${numero(sequencial, 6)}`;

/** @returns {string} conteúdo do arquivo */
function gerarRetorno(conta, registros, { gerado_em = '2026-12-20', credito_em = '2026-12-20', sequencial = 1 } = {}) {
  const linhas = [header(conta, { gerado_em, credito_em, sequencial })];
  for (const r of registros) {
    linhas.push(detalhe(r, linhas.length + 1));
    if (r.rateio) linhas.push(rateio(r, linhas.length + 1));
  }
  const feitos = registros.filter((r) => r.rateio && ['38', '39'].includes(String(r.rateio.motivo)));
  linhas.push(trailer(linhas.length + 1, {
    rateio_total_centavos: feitos.reduce((s, r) => s + (r.rateio.valor_centavos ?? 0), 0), rateio_quantidade: feitos.length, ...(registros.trailer ?? {}) }));
  return `${linhas.join('\r\n')}\r\n`;
}

module.exports = { gerarRetorno, header, detalhe, rateio, trailer };
