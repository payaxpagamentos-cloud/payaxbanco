'use strict';

/**
 * PIX "copia e cola" (BR Code estático com valor), no padrão EMV do Banco Central.
 * O pagamento cai na chave PIX da plataforma; a confirmação é feita pelo motorista ou pela central.
 */
const campo = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`;

/** Remove acentos e caracteres fora do conjunto aceito pelos bancos. */
const limpar = (t, max) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-/]/g, '').trim().slice(0, max);

function crc16(texto) {
  let crc = 0xffff;
  for (const byte of Buffer.from(texto, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function copiaECola({ chave, recebedor, cidade, valorCentavos, txid, descricao }) {
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', chave) + (descricao ? campo('02', limpar(descricao, 40)) : '');
  const corpo = campo('00', '01')
    + campo('26', conta)
    + campo('52', '0000')
    + campo('53', '986')
    + (valorCentavos ? campo('54', (valorCentavos / 100).toFixed(2)) : '')
    + campo('58', 'BR')
    + campo('59', limpar(recebedor, 25) || 'RECEBEDOR')
    + campo('60', limpar(cidade, 15) || 'BRASIL')
    + campo('62', campo('05', String(txid ?? '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***'))
    + '6304';
  return corpo + crc16(corpo);
}

module.exports = { copiaECola, crc16 };
