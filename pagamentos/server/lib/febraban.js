'use strict';

/*
 * Código de barras, linha digitável e nosso número no padrão FEBRABAN, com o campo livre do Bradesco (banco 237).
 *
 * Código de barras (44 dígitos):
 *   1-3 banco | 4 moeda (9) | 5 DV geral | 6-9 fator de vencimento | 10-19 valor | 20-44 campo livre
 * Campo livre do Bradesco (25 dígitos, carteira com registro):
 *   agência (4) | carteira (2) | nosso número (11) | conta (7) | zero (1)
 */

const so = (s) => String(s ?? '').replace(/\D/g, '');
const z = (v, n) => so(v).padStart(n, '0').slice(-n);

/** Módulo 10 (dígito dos campos da linha digitável). */
function mod10(num) {
  let soma = 0;
  let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    let p = Number(num[i]) * peso;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    soma += p;
    peso = peso === 2 ? 1 : 2;
  }
  return (10 - (soma % 10)) % 10;
}

/** Soma ponderada 2..9 da direita para a esquerda, módulo 11. */
function somaMod11(num, pesoMax = 9) {
  let soma = 0;
  let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    soma += Number(num[i]) * peso;
    peso = peso === pesoMax ? 2 : peso + 1;
  }
  return soma % 11;
}

/** DV geral do código de barras (resto 0, 10 ou 11 vira 1). */
function dvCodigoBarras(num43) {
  const dv = 11 - somaMod11(num43);
  return dv === 0 || dv > 9 ? 1 : dv;
}

/**
 * DV do nosso número no Bradesco: módulo 11 com pesos 2..7 sobre carteira (2) + nosso número (11).
 * Resto 0 → '0'; resto 1 → 'P'; demais → 11 - resto.
 */
function dvNossoNumeroBradesco(carteira, nossoNumero) {
  const base = z(carteira, 2) + z(nossoNumero, 11);
  let soma = 0;
  let peso = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    soma += Number(base[i]) * peso;
    peso = peso === 7 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  if (resto === 0) return '0';
  if (resto === 1) return 'P';
  return String(11 - resto);
}

/**
 * Fator de vencimento: base 07/10/1997; ao chegar em 9999 (21/02/2025) reiniciou em 1000.
 * Vencimentos a partir de 22/02/2025 usam a base nova — é o caso de tudo que o sistema emite.
 */
function fatorVencimento(vencimento) {
  const d = Date.parse(`${vencimento}T00:00:00Z`);
  const fator = 1000 + Math.round((d - Date.UTC(2025, 1, 22)) / 86_400_000);
  // Fora da faixa válida (ex.: vencimento muito antigo), o padrão manda usar 0000.
  return fator >= 1000 && fator <= 9999 ? String(fator) : '0000';
}

/** Data de vencimento a partir do fator (aceita as duas bases, escolhendo a mais próxima de hoje). */
function vencimentoPorFator(fator, hoje = new Date()) {
  if (!fator) return null;
  const dia = 86_400_000;
  const candidatas = [Date.UTC(1997, 9, 7) + fator * dia];
  if (fator >= 1000) candidatas.push(Date.UTC(2025, 1, 22) + (fator - 1000) * dia);
  const melhor = candidatas.sort((a, b) => Math.abs(a - hoje) - Math.abs(b - hoje))[0];
  return new Date(melhor).toISOString().slice(0, 10);
}

/** Linha digitável (47 dígitos) a partir do código de barras (44). */
function linhaDigitavel(barras) {
  const campo = (s) => s + mod10(s);
  return campo(barras.slice(0, 4) + barras.slice(19, 24))
    + campo(barras.slice(24, 34))
    + campo(barras.slice(34, 44))
    + barras[4]
    + barras.slice(5, 19);
}

/** Linha digitável formatada para leitura humana. */
const formatarLinha = (l) => (so(l).length === 47
  ? `${l.slice(0, 5)}.${l.slice(5, 10)} ${l.slice(10, 15)}.${l.slice(15, 21)} ${l.slice(21, 26)}.${l.slice(26, 32)} ${l[32]} ${l.slice(33)}`
  : l);

const formatarNossoNumero = (nn, dv) => `${z(nn, 11)}-${dv}`;

/**
 * Monta o código de barras e a linha digitável de um boleto Bradesco.
 * @param {{agencia: string, conta: string, carteira: string, nossoNumero: string|number, valorCentavos: number, vencimento: string}} dados
 */
function boletoBradesco({ agencia, conta, carteira = '09', nossoNumero, valorCentavos, vencimento }) {
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) throw new Error('Valor do boleto inválido.');
  if (valorCentavos > 9_999_999_999) throw new Error('Valor acima do que cabe no código de barras.');
  const campoLivre = z(agencia, 4) + z(carteira, 2) + z(nossoNumero, 11) + z(conta, 7) + '0';
  const semDv = `2379${fatorVencimento(vencimento)}${z(valorCentavos, 10)}${campoLivre}`;
  const barras = `${semDv.slice(0, 4)}${dvCodigoBarras(semDv)}${semDv.slice(4)}`;
  return {
    codigo_barras: barras,
    linha_digitavel: linhaDigitavel(barras),
    nosso_numero: z(nossoNumero, 11),
    nosso_numero_dv: dvNossoNumeroBradesco(carteira, nossoNumero),
  };
}

/** Confere um código de barras de 44 dígitos (usado na conciliação do retorno). */
function conferirCodigoBarras(barras) {
  const b = so(barras);
  if (b.length !== 44) return false;
  return dvCodigoBarras(b.slice(0, 4) + b.slice(5)) === Number(b[4]);
}

/** Lê valor, vencimento e nosso número de um código de barras do Bradesco. */
function lerCodigoBarras(barras) {
  const b = so(barras);
  if (!conferirCodigoBarras(b)) return null;
  return {
    banco: b.slice(0, 3),
    vencimento: vencimentoPorFator(Number(b.slice(5, 9))),
    valor_centavos: Number(b.slice(9, 19)),
    agencia: b.slice(19, 23),
    carteira: b.slice(23, 25),
    nosso_numero: b.slice(25, 36),
    conta: b.slice(36, 43),
  };
}

module.exports = { mod10, somaMod11, dvCodigoBarras, dvNossoNumeroBradesco, fatorVencimento, vencimentoPorFator,
  linhaDigitavel, formatarLinha, formatarNossoNumero, boletoBradesco, conferirCodigoBarras, lerCodigoBarras };
