'use strict';

const { ErroNegocio } = require('../erros');

/*
 * ASN.1 DER: o mínimo para ler um certificado A1 e montar a assinatura da NFCom.
 *
 * Por que escrever isto em vez de usar o Node: o Node não abre arquivo PKCS#12 (.pfx) para tirar a chave
 * privada — só sabe usá-lo dentro de uma conexão TLS. E chamar o `openssl` por fora significaria a chave
 * privada do provedor trafegando pela saída de um processo filho. Para assinar a nota fiscal é preciso ter
 * a chave aqui dentro, então o arquivo é lido aqui dentro.
 *
 * DER é simples: todo valor é TAG + TAMANHO + CONTEÚDO. O tamanho vem em forma curta (um byte, até 127)
 * ou longa (o primeiro byte diz quantos bytes de tamanho vêm a seguir). Não há mais nada.
 */

/* Tags que aparecem num .pfx e numa assinatura. */
const TAG = {
  INTEIRO: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULO: 0x05,
  OID: 0x06,
  SEQUENCIA: 0x30,
  CONJUNTO: 0x31,
  CONTEXTO_0: 0xa0,
};

/** Lê um valor a partir de `pos`. Devolve a tag, o conteúdo e onde o próximo valor começa. */
function lerValor(buf, pos = 0) {
  if (pos + 2 > buf.length) throw new ErroNegocio('Arquivo truncado: faltou cabeçalho ASN.1.', 422);
  const tag = buf[pos];
  let p = pos + 1;
  let tamanho = buf[p++];
  if (tamanho & 0x80) {
    const bytes = tamanho & 0x7f;
    // 0x80 é tamanho indefinido: só existe em BER, e o PKCS#12 é DER. Recusar é melhor do que adivinhar.
    if (bytes === 0 || bytes > 4) throw new ErroNegocio('Arquivo em formato BER (tamanho indefinido ou longo demais); era esperado DER.', 422);
    tamanho = 0;
    for (let i = 0; i < bytes; i++) tamanho = tamanho * 256 + buf[p++];
  }
  const fim = p + tamanho;
  if (fim > buf.length) throw new ErroNegocio('Arquivo truncado: o tamanho declarado passa do fim do arquivo.', 422);
  return { tag, conteudo: buf.subarray(p, fim), fim };
}

/** Todos os valores de dentro de um conteúdo (o que há dentro de uma SEQUENCE, por exemplo). */
function filhos(conteudo) {
  const lista = [];
  let pos = 0;
  while (pos < conteudo.length) {
    const v = lerValor(conteudo, pos);
    lista.push(v);
    pos = v.fim;
  }
  return lista;
}

/** Os filhos de um valor que precisa ser uma SEQUENCE (ou um CONJUNTO). */
function dentro(valor, tagEsperada = TAG.SEQUENCIA) {
  if (valor.tag !== tagEsperada) {
    throw new ErroNegocio(`Estrutura inesperada no arquivo: era esperado 0x${tagEsperada.toString(16)} e veio 0x${valor.tag.toString(16)}.`, 422);
  }
  return filhos(valor.conteudo);
}

/** OID no formato pontuado, por exemplo "1.2.840.113549.1.12.10.1.2". */
function oid(conteudo) {
  const partes = [Math.floor(conteudo[0] / 40), conteudo[0] % 40];
  let atual = 0;
  for (let i = 1; i < conteudo.length; i++) {
    atual = atual * 128 + (conteudo[i] & 0x7f);
    if (!(conteudo[i] & 0x80)) { partes.push(atual); atual = 0; }
  }
  return partes.join('.');
}

/** Inteiro pequeno (contador de iterações, versão). Valores grandes não aparecem onde usamos isto. */
function inteiro(conteudo) {
  let n = 0;
  for (const b of conteudo) n = n * 256 + b;
  return n;
}

/** Monta um valor DER: usado para reembrulhar a chave no formato que o Node aceita. */
function montar(tag, conteudo) {
  const corpo = Buffer.isBuffer(conteudo) ? conteudo : Buffer.concat(conteudo);
  if (corpo.length < 0x80) return Buffer.concat([Buffer.from([tag, corpo.length]), corpo]);
  const bytes = [];
  let n = corpo.length;
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), corpo]);
}

/** DER cru para o PEM que o Node lê. */
function pem(der, rotulo) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${rotulo}-----\n${b64}\n-----END ${rotulo}-----\n`;
}

module.exports = { TAG, lerValor, filhos, dentro, oid, inteiro, montar, pem };
