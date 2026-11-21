'use strict';

const { ErroNegocio } = require('./erros');

/*
 * PIX: o BR Code (padrão EMV®QRCPS adotado pelo Banco Central).
 *
 * Não depende de banco, de API nem de credenciamento: com a chave PIX do provedor, o código de pagamento
 * é CALCULADO aqui. É por isso que o PIX é a primeira forma de cobrança a funcionar neste sistema — o
 * boleto registrado precisa de convênio, o PIX precisa só da chave.
 *
 * O que o código traz: a chave, o valor, o nome e a cidade do beneficiário e um identificador (txid) que
 * amarra o pagamento à fatura. Quem concilia o recebimento é o extrato ou o adaptador do banco; aqui se
 * monta o que o assinante lê ou copia.
 */

/** Campo EMV: identificador (2) + tamanho (2) + valor. */
const campo = (id, valor) => {
  const v = String(valor);
  if (v.length > 99) throw new ErroNegocio(`Campo ${id} do PIX longo demais (${v.length}).`, 422);
  return `${id}${String(v.length).padStart(2, '0')}${v}`;
};

/**
 * CRC16/CCITT-FALSE: polinômio 0x1021, valor inicial 0xFFFF, sem reflexão e sem XOR final.
 * É o que fecha o BR Code; errar aqui faz o aplicativo do banco recusar o código.
 */
function crc16(texto) {
  let crc = 0xffff;
  for (const byte of Buffer.from(texto, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/*
 * Texto que vai no BR Code. O padrão aceita só um subconjunto do ASCII: acento e símbolo fazem
 * leitor de banco recusar, então o nome do beneficiário é transliterado em vez de ir como foi digitado.
 */
const limpar = (texto, maximo) => String(texto ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9 .,\-/]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximo)
  .toUpperCase();

/** O txid amarra o pagamento à fatura: de 1 a 25 caracteres, só letras e números. */
function txidDaFatura(numero, prefixo = 'FAT') {
  const t = `${limpar(prefixo, 10).replace(/[^A-Z0-9]/g, '')}${String(numero)}`.slice(0, 25);
  return t || '***';
}

/**
 * Monta o BR Code (o "copia e cola" do PIX).
 *
 * `valor` em centavos. Sem valor, o código fica em aberto e o assinante digita quanto pagar — o que só
 * faz sentido para doação, nunca para fatura, então o valor é obrigatório aqui.
 */
function brcode({ chave, valor_centavos: valor, beneficiario, cidade, txid = '***', descricao = null }) {
  const k = String(chave ?? '').trim();
  if (!k) throw new ErroNegocio('A conta de cobrança não tem chave PIX.', 422);
  if (k.length > 77) throw new ErroNegocio('Chave PIX longa demais.', 422);
  if (!Number.isInteger(valor) || valor <= 0) throw new ErroNegocio('O valor do PIX precisa ser maior que zero.', 422);
  const nome = limpar(beneficiario, 25);
  const municipio = limpar(cidade, 15);
  if (!nome) throw new ErroNegocio('A conta de cobrança precisa do nome do beneficiário para o PIX.', 422);
  if (!municipio) throw new ErroNegocio('A conta de cobrança precisa da cidade do beneficiário para o PIX.', 422);
  const identificador = limpar(txid, 25).replace(/[^A-Z0-9]/g, '') || '***';

  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', k) + (descricao ? campo('02', limpar(descricao, 72)) : '');
  const corpo = campo('00', '01')
    + campo('26', conta)
    + campo('52', '0000')
    + campo('53', '986')
    + campo('54', (valor / 100).toFixed(2))
    + campo('58', 'BR')
    + campo('59', nome)
    + campo('60', municipio)
    + campo('62', campo('05', identificador));
  // O CRC é calculado sobre o payload inteiro JÁ COM "6304" no fim.
  const comMarcador = `${corpo}6304`;
  return `${comMarcador}${crc16(comMarcador)}`;
}

/** Confere um BR Code recebido: o CRC tem de bater com o conteúdo. */
function conferir(codigo) {
  const t = String(codigo ?? '');
  if (t.length < 8 || !t.slice(-8, -4).startsWith('63')) return false;
  return crc16(t.slice(0, -4)) === t.slice(-4).toUpperCase();
}

/** Lê os campos de um BR Code, para conferência na tela e nos testes. */
function ler(codigo) {
  const campos = {};
  let i = 0;
  const t = String(codigo ?? '');
  while (i + 4 <= t.length) {
    const id = t.slice(i, i + 2);
    const n = Number(t.slice(i + 2, i + 4));
    if (!Number.isFinite(n) || i + 4 + n > t.length) break;
    campos[id] = t.slice(i + 4, i + 4 + n);
    i += 4 + n;
  }
  const conta = campos['26'] ? ler(campos['26']) : {};
  return {
    chave: conta.campos?.['01'] ?? null,
    valor_centavos: campos['54'] ? Math.round(Number(campos['54']) * 100) : null,
    beneficiario: campos['59'] ?? null,
    cidade: campos['60'] ?? null,
    txid: campos['62'] ? ler(campos['62']).campos?.['05'] ?? null : null,
    valido: conferir(codigo),
    campos,
  };
}

module.exports = { brcode, conferir, ler, crc16, txidDaFatura, limpar };
