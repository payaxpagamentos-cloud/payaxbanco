'use strict';

/* Geração de BR Code (PIX copia e cola) no padrão EMV-QRCPS do Banco Central. */

const campo = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`;

/** CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF), exigido no campo 63. */
function crc16(texto) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(texto)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const limpar = (s, max) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, max);

/**
 * BR Code dinâmico: aponta para a URL (location) da cobrança no PSP.
 * Quando não há location (ex.: simulador), usa a chave PIX.
 */
function gerarBrCode({ location, chave, nome, cidade, valorCentavos, txid }) {
  const conta = campo('00', 'br.gov.bcb.pix') + (location ? campo('25', location) : campo('01', chave));
  const corpo = campo('00', '01')
    + campo('01', '12')
    + campo('26', conta)
    + campo('52', '0000')
    + campo('53', '986')
    + (valorCentavos ? campo('54', (valorCentavos / 100).toFixed(2)) : '')
    + campo('58', 'BR')
    + campo('59', limpar(nome, 25) || 'PAY AX')
    + campo('60', limpar(cidade, 15) || 'SAO PAULO')
    + campo('62', campo('05', location ? '***' : String(txid || '***').slice(0, 25)))
    + '6304';
  return corpo + crc16(corpo);
}

module.exports = { gerarBrCode, crc16 };
