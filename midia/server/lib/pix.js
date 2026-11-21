'use strict';

/**
 * PIX "copia e cola" (BR Code, padrão EMV do Banco Central) para o anunciante pagar a fatura: chave, valor e identificador.
 * Funciona em qualquer banco, sem intermediário; a baixa é feita no painel por quem confere o extrato.
 */
const campo = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`;
const semAcento = (t, max) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-@]/g, '').trim().slice(0, max).toUpperCase();

function crc16(texto) {
  let crc = 0xffff;
  for (const b of Buffer.from(texto, 'utf8')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** `txid`: até 25 letras/números (identifica a fatura no extrato do banco). */
function copiaECola({ chave, nome, cidade, valorCentavos, txid }) {
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', String(chave).trim());
  const id = String(txid ?? '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const corpo = campo('00', '01') + campo('26', conta) + campo('52', '0000') + campo('53', '986')
    + (valorCentavos ? campo('54', (valorCentavos / 100).toFixed(2)) : '') + campo('58', 'BR')
    + campo('59', semAcento(nome, 25) || 'MIDIA INDOOR') + campo('60', semAcento(cidade, 15) || 'SAO PAULO') + campo('62', campo('05', id)) + '6304';
  return corpo + crc16(corpo);
}

module.exports = { copiaECola, crc16 };
