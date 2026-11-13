'use strict';

/**
 * BR Code (PIX "copia e cola", padrão EMV do Banco Central) para o Bolepix: o mesmo título pago
 * pelo código de barras OU pelo QR Code. O txid liga o PIX ao boleto na conciliação.
 */
const campo = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`;
const semAcento = (t, max) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9 .\-@]/g, '').trim().slice(0, max).toUpperCase();

function crc16(texto) {
  let crc = 0xffff;
  for (const b of Buffer.from(texto, 'utf8')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * BR Code estático com valor. `txid`: até 25 letras/números — usamos o nosso número do boleto,
 * que volta no aviso de liquidação e permite casar o PIX com o título.
 */
function copiaECola({ chave, nome, cidade, valorCentavos, txid }) {
  if (!chave) throw new Error('Conta sem chave PIX cadastrada: não é possível gerar o Bolepix.');
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', String(chave).trim());
  const id = String(txid ?? '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const corpo = campo('00', '01')
    + campo('26', conta)
    + campo('52', '0000')
    + campo('53', '986')
    + (valorCentavos ? campo('54', (valorCentavos / 100).toFixed(2)) : '')
    + campo('58', 'BR')
    + campo('59', semAcento(nome, 25) || 'PAYAX PAGAMENTOS')
    + campo('60', semAcento(cidade, 15) || 'SAO PAULO')
    + campo('62', campo('05', id))
    + '6304';
  return corpo + crc16(corpo);
}

/** Lê um BR Code em pares id/tamanho/valor (usado para conferir o que o banco devolveu). */
function ler(emv) {
  const campos = {};
  let i = 0;
  const texto = String(emv ?? '');
  while (i + 4 <= texto.length) {
    const id = texto.slice(i, i + 2);
    const tam = Number(texto.slice(i + 2, i + 4));
    if (!Number.isInteger(tam)) break;
    campos[id] = texto.slice(i + 4, i + 4 + tam);
    i += 4 + tam;
  }
  return campos;
}

/** Confere o CRC de um BR Code recebido. */
function valido(emv) {
  const t = String(emv ?? '');
  if (t.length < 8 || !t.slice(-8, -4).includes('6304')) return t.length > 8 && crc16(t.slice(0, -4)) === t.slice(-4).toUpperCase();
  return crc16(t.slice(0, -4)) === t.slice(-4).toUpperCase();
}

module.exports = { copiaECola, crc16, ler, valido };
