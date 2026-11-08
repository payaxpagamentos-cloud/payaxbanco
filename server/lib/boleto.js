'use strict';

/*
 * Leitura e validação de boletos no padrão FEBRABAN.
 * - Boleto bancário: linha digitável de 47 dígitos (código de barras de 44).
 * - Arrecadação/convênio (água, luz, tributos): 48 dígitos, começa com 8.
 */
const { ErroNegocio } = require('./erros');

const so = (s) => String(s ?? '').replace(/\D/g, '');

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

function somaMod11(num) {
  let soma = 0;
  let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    soma += Number(num[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  return soma % 11;
}

/** DV geral do código de barras de boleto bancário (0, 10 e 11 viram 1). */
function dvBoletoBancario(num43) {
  const dv = 11 - somaMod11(num43);
  return dv === 0 || dv > 9 ? 1 : dv;
}

/** DV módulo 11 da arrecadação (resto 0 ou 1 vira 0). */
function mod11Arrecadacao(num) {
  const dv = 11 - somaMod11(num);
  return dv > 9 ? 0 : dv;
}

/** Fator de vencimento: base 07/10/1997, reiniciado em 1000 a partir de 22/02/2025. Escolhe a data mais próxima de hoje. */
function vencimentoPorFator(fator, hoje = new Date()) {
  if (!fator) return null;
  const dia = 86_400_000;
  const candidatas = [Date.UTC(1997, 9, 7) + fator * dia];
  if (fator >= 1000) candidatas.push(Date.UTC(2025, 1, 22) + (fator - 1000) * dia);
  const melhor = candidatas.sort((a, b) => Math.abs(a - hoje) - Math.abs(b - hoje))[0];
  return new Date(melhor).toISOString().slice(0, 10);
}

function fatorPorVencimento(dataIso) {
  const d = Date.parse(`${dataIso}T00:00:00Z`);
  return 1000 + Math.round((d - Date.UTC(2025, 1, 22)) / 86_400_000);
}

const invalido = (msg) => new ErroNegocio(msg, 422);

function lerBoletoBancario(linha) {
  const campos = [linha.slice(0, 10), linha.slice(10, 21), linha.slice(21, 32)];
  campos.forEach((c, i) => {
    if (mod10(c.slice(0, -1)) !== Number(c.at(-1))) throw invalido(`Dígito do campo ${i + 1} não confere. Confira a linha digitável.`);
  });
  const barras = linha.slice(0, 4) + linha[32] + linha.slice(33, 47) + linha.slice(4, 9) + linha.slice(10, 20) + linha.slice(21, 31);
  if (dvBoletoBancario(barras.slice(0, 4) + barras.slice(5)) !== Number(barras[4])) throw invalido('Dígito verificador geral não confere.');
  return {
    tipo: 'boleto',
    codigo_barras: barras,
    linha_digitavel: linha,
    banco: barras.slice(0, 3),
    valor_centavos: Number(barras.slice(9, 19)),
    vencimento: vencimentoPorFator(Number(barras.slice(5, 9))),
  };
}

function lerConvenio(linha) {
  const ref = Number(linha[2]);
  if (![6, 7, 8, 9].includes(ref)) throw invalido('Código de arrecadação inválido.');
  const dv = ref <= 7 ? mod10 : mod11Arrecadacao;
  const blocos = [0, 1, 2, 3].map((i) => linha.slice(i * 12, i * 12 + 12));
  blocos.forEach((b, i) => {
    if (dv(b.slice(0, 11)) !== Number(b[11])) throw invalido(`Dígito do bloco ${i + 1} não confere. Confira o código.`);
  });
  const barras = blocos.map((b) => b.slice(0, 11)).join('');
  if (dv(barras.slice(0, 3) + barras.slice(4)) !== Number(barras[3])) throw invalido('Dígito verificador geral não confere.');
  return {
    tipo: 'convenio',
    codigo_barras: barras,
    linha_digitavel: linha,
    segmento: barras[1],
    valor_centavos: ref === 6 || ref === 8 ? Number(barras.slice(4, 15)) : 0,
    vencimento: null,
  };
}

/** Valida a linha digitável (ou código de barras de 44 dígitos) e extrai valor e vencimento. */
function lerBoleto(entrada) {
  let d = so(entrada);
  if (d.length === 44) d = d[0] === '8' ? linhaDeConvenio(d) : linhaDeBoleto(d);
  if (d.length === 47) return lerBoletoBancario(d);
  if (d.length === 48 && d[0] === '8') return lerConvenio(d);
  throw invalido('Informe a linha digitável completa (47 dígitos para boletos, 48 para contas de consumo).');
}

/** Monta a linha digitável a partir do código de barras de boleto bancário (44 dígitos). */
function linhaDeBoleto(barras) {
  const campo = (s) => s + mod10(s);
  return campo(barras.slice(0, 4) + barras.slice(19, 24)) + campo(barras.slice(24, 34)) + campo(barras.slice(34, 44)) + barras[4] + barras.slice(5, 19);
}

function linhaDeConvenio(barras) {
  const dv = Number(barras[2]) <= 7 ? mod10 : mod11Arrecadacao;
  return [0, 1, 2, 3].map((i) => { const b = barras.slice(i * 11, i * 11 + 11); return b + dv(b); }).join('');
}

/** Gera um boleto bancário válido (usado em testes e no simulador). */
function gerarBoletoBancario({ banco = '237', valorCentavos, vencimento, campoLivre }) {
  const livre = (campoLivre ?? '').padStart(25, '0').slice(-25);
  const fator = vencimento ? String(fatorPorVencimento(vencimento)).padStart(4, '0') : '0000';
  const semDv = `${banco}9${fator}${String(valorCentavos).padStart(10, '0')}${livre}`;
  const barras = semDv.slice(0, 4) + dvBoletoBancario(semDv) + semDv.slice(4);
  return { codigo_barras: barras, linha_digitavel: linhaDeBoleto(barras) };
}

/** Gera uma conta de consumo (arrecadação) válida, com valor efetivo em reais (identificador 6). */
function gerarConvenio({ segmento = '2', valorCentavos, empresa = '0123', livre = '' }) {
  const semDv = `8${segmento}6${String(valorCentavos).padStart(11, '0')}${empresa}${String(livre).padStart(25, '0').slice(-25)}`;
  const barras = semDv.slice(0, 3) + mod10(semDv) + semDv.slice(3);
  return { codigo_barras: barras, linha_digitavel: linhaDeConvenio(barras) };
}

const formatarLinha = (l) => (l.length === 47
  ? `${l.slice(0, 5)}.${l.slice(5, 10)} ${l.slice(10, 15)}.${l.slice(15, 21)} ${l.slice(21, 26)}.${l.slice(26, 32)} ${l[32]} ${l.slice(33)}`
  : l.match(/.{12}/g).map((b) => `${b.slice(0, 11)}-${b[11]}`).join(' '));

module.exports = { lerBoleto, gerarBoletoBancario, gerarConvenio, formatarLinha, vencimentoPorFator, mod10, mod11Arrecadacao };
