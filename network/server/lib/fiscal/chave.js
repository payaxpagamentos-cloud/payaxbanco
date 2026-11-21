'use strict';

const crypto = require('node:crypto');
const { ErroNegocio } = require('../erros');

/*
 * Chave de acesso da NFCom: 44 dígitos.
 *
 * ATENÇÃO — ela NÃO é igual à da NF-e, e essa é a armadilha deste arquivo. Quem copiar o cálculo da NF-e
 * monta uma chave errada que passa por todos os testes de formato e é recusada pela SEFAZ. As diferenças:
 *
 *   NF-e : ... nNF(9) tpEmis(1)                  cNF(8) cDV(1)
 *   NFCom: ... nNF(9) tpEmis(1) nSiteAutoriz(1)  cNF(7) cDV(1)
 *
 * A NFCom tem um campo a mais — nSiteAutoriz, o site do autorizador que recebeu a nota — e, para caber
 * nos mesmos 44 dígitos, o código numérico encolheu de 8 para 7.
 *
 * Fonte: MOC NFCom, Visão Geral, item 2.1.3 (Tabela 2-1) e item 5.3.
 */

const CAMPOS = [
  ['cUF', 2], ['AAMM', 4], ['CNPJ', 14], ['mod', 2], ['serie', 3],
  ['nNF', 9], ['tpEmis', 1], ['nSiteAutoriz', 1], ['cNF', 7],
];
const TAMANHO = 44;
const MODELO = '62';

const digitos = (v) => String(v ?? '').replace(/\D/g, '');
const zeros = (v, n) => digitos(v).padStart(n, '0').slice(-n);

/**
 * Dígito verificador: módulo 11 com pesos 2 a 9 cíclicos, da direita para a esquerda, sobre os 43
 * primeiros dígitos. O dígito é 11 menos o resto; resto 0 ou 1 dá dígito 0.
 *
 * (MOC NFCom, Visão Geral, 5.3. O exemplo do manual — soma 644, resto 6, dígito 5 — está no teste.)
 */
function digitoVerificador(base43) {
  const n = digitos(base43);
  if (n.length !== 43) throw new ErroNegocio(`A base da chave precisa ter 43 dígitos (veio ${n.length}).`, 422);
  let soma = 0;
  let peso = 2;
  for (let i = n.length - 1; i >= 0; i--) {
    soma += Number(n[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto === 0 || resto === 1 ? 0 : 11 - resto;
}

/**
 * Código numérico aleatório de 7 dígitos.
 *
 * Ele existe para que a chave não seja adivinhável a partir do número da nota. Por isso vem do gerador
 * criptográfico, e não de Math.random: a chave é o que permite consultar a nota no portal da SEFAZ.
 */
function codigoNumerico() {
  // 10.000.000 é 7 dígitos; o laço descarta o resto da divisão para não enviesar os valores baixos.
  const limite = 10_000_000;
  const maximo = Math.floor(0xffffffff / limite) * limite;
  let n;
  do { n = crypto.randomBytes(4).readUInt32BE(0); } while (n >= maximo);
  return zeros(n % limite, 7);
}

/** Monta a chave inteira. Devolve a chave, o cNF usado e o dígito, porque os três vão para o XML. */
function montar({ cUF, ano, mes, cnpj, serie, numero, tpEmis = 1, nSiteAutoriz = 0, cNF }) {
  const codigo = cNF ? zeros(cNF, 7) : codigoNumerico();
  const base = [
    zeros(cUF, 2),
    zeros(ano, 4).slice(-2) + zeros(mes, 2),
    zeros(cnpj, 14),
    MODELO,
    zeros(serie, 3),
    zeros(numero, 9),
    zeros(tpEmis, 1),
    zeros(nSiteAutoriz, 1),
    codigo,
  ].join('');
  if (base.length !== 43) throw new ErroNegocio(`Erro ao montar a chave: a base saiu com ${base.length} dígitos em vez de 43.`, 500);
  const dv = digitoVerificador(base);
  return { chave: base + dv, cNF: codigo, cDV: String(dv) };
}

/** Abre uma chave de 44 dígitos em seus campos. Serve para conferir o que a SEFAZ devolveu. */
function ler(chave) {
  const n = digitos(chave);
  if (n.length !== TAMANHO) throw new ErroNegocio(`A chave de acesso precisa ter 44 dígitos (veio ${n.length}).`, 422);
  const fora = {};
  let pos = 0;
  for (const [nome, tam] of CAMPOS) { fora[nome] = n.slice(pos, pos + tam); pos += tam; }
  fora.cDV = n.slice(43);
  fora.confere = String(digitoVerificador(n.slice(0, 43))) === fora.cDV;
  fora.chave = n;
  return fora;
}

/** Confere o dígito. Usado antes de aceitar uma chave digitada ou vinda de fora. */
const conferir = (chave) => {
  const n = digitos(chave);
  return n.length === TAMANHO && String(digitoVerificador(n.slice(0, 43))) === n.slice(43);
};

/** A chave como o DANFE-Com a imprime: 11 blocos de 4 dígitos. */
const formatar = (chave) => digitos(chave).replace(/(\d{4})(?=\d)/g, '$1 ');

module.exports = { TAMANHO, MODELO, montar, ler, conferir, formatar, digitoVerificador, codigoNumerico };
