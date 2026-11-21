'use strict';

const { ErroNegocio } = require('./erros');
const { diasEntre } = require('./datas');

/*
 * Boleto: o código de barras e a linha digitável.
 *
 * Há duas partes aqui, e a diferença entre elas é importante:
 *
 * 1. O QUE É UNIVERSAL (FEBRABAN, igual em todo banco): a montagem dos 44 dígitos, o dígito verificador
 *    geral, o fator de vencimento e a linha digitável. Isso está implementado por inteiro e é conferido
 *    nos testes, inclusive pela volta — da linha digitável se reconstrói o código de barras.
 *
 * 2. O QUE É DE CADA BANCO: os 25 dígitos do "campo livre" e o dígito do nosso número. Cada banco monta à
 *    sua maneira, e a maneira muda com a carteira e o convênio contratados. O que está aqui são os layouts
 *    mais comuns, e CADA UM VEM MARCADO COMO NÃO VALIDADO: antes da primeira remessa em produção, o
 *    provedor precisa conferir um boleto de teste com o banco dele. O sistema repete esse aviso na tela,
 *    porque campo livre errado é boleto que não liquida — e o erro só aparece quando o cliente já pagou.
 */

const digitos = (v) => String(v ?? '').replace(/\D/g, '');
const zeros = (v, n) => digitos(v).padStart(n, '0').slice(-n);

/** Módulo 10: pesos 2 e 1 alternados da direita para a esquerda, somando os dígitos do produto. */
function modulo10(numero) {
  const n = digitos(numero);
  let soma = 0;
  let peso = 2;
  for (let i = n.length - 1; i >= 0; i--) {
    const p = Number(n[i]) * peso;
    soma += p > 9 ? p - 9 : p;
    peso = peso === 2 ? 1 : 2;
  }
  const resto = soma % 10;
  return resto === 0 ? 0 : 10 - resto;
}

/** Módulo 11 do código de barras: pesos 2 a 9 cíclicos; resto 0, 1 ou 10 vira dígito 1. */
function modulo11Barra(numero) {
  const n = digitos(numero);
  let soma = 0;
  let peso = 2;
  for (let i = n.length - 1; i >= 0; i--) {
    soma += Number(n[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  const dv = 11 - resto;
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/** Módulo 11 do nosso número (base 9, usado por vários bancos): resto 0 vira 0 e resto 1 vira P ou 0. */
function modulo11Base9(numero, { restoUmComoP = false } = {}) {
  const n = digitos(numero);
  let soma = 0;
  let peso = 2;
  for (let i = n.length - 1; i >= 0; i--) {
    soma += Number(n[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  if (resto === 0) return '0';
  if (resto === 1) return restoUmComoP ? 'P' : '0';
  return String(11 - resto);
}

/*
 * Fator de vencimento: dias desde 07/10/1997. Ao chegar em 9999 (21/02/2025) ele voltou para 1000,
 * por determinação da FEBRABAN — quem não tratou isso emitiu boleto com vencimento de 1997.
 */
const BASE_FATOR = '1997-10-07';
function fatorVencimento(data) {
  const dias = diasEntre(BASE_FATOR, String(data).slice(0, 10));
  if (dias < 1000) throw new ErroNegocio('Vencimento anterior ao que o padrão do boleto aceita.', 422);
  return String(dias <= 9999 ? dias : ((dias - 1000) % 9000) + 1000).padStart(4, '0');
}

/** A data que um fator representa, para conferir a leitura de um código de barras. */
function vencimentoDoFator(fator, { referencia = new Date().toISOString().slice(0, 10) } = {}) {
  const n = Number(fator);
  const base = Date.parse(`${BASE_FATOR}T12:00:00Z`);
  // Depois da virada, o mesmo fator serve a mais de uma data: vale a mais próxima da referência.
  const candidatos = [n, n + 9000, n + 18000].map((d) => new Date(base + d * 86400_000).toISOString().slice(0, 10));
  const alvo = Date.parse(`${referencia}T12:00:00Z`);
  return candidatos.reduce((a, b) => (Math.abs(Date.parse(`${b}T12:00:00Z`) - alvo) < Math.abs(Date.parse(`${a}T12:00:00Z`) - alvo) ? b : a));
}

/**
 * Os 44 dígitos do código de barras.
 * banco(3) moeda(1) DV(1) fator(4) valor(10) campo livre(25)
 */
function codigoBarras({ banco, valor_centavos: valor, vencimento, campo_livre: campoLivre }) {
  const b = zeros(banco, 3);
  const livre = digitos(campoLivre);
  if (livre.length !== 25) throw new ErroNegocio(`O campo livre do banco ${b} precisa ter 25 dígitos (veio com ${livre.length}).`, 422);
  if (!Number.isInteger(valor) || valor <= 0) throw new ErroNegocio('Valor do boleto inválido.', 422);
  if (valor > 9_999_999_999) throw new ErroNegocio('Valor acima do que o código de barras comporta.', 422);
  const semDv = `${b}9${fatorVencimento(vencimento)}${zeros(valor, 10)}${livre}`;
  const dv = modulo11Barra(semDv);
  return `${b}9${dv}${semDv.slice(4)}`;
}

/**
 * Linha digitável (47 dígitos) a partir do código de barras.
 * Campos 1 a 3 levam DV módulo 10 cada; o campo 4 é o DV geral e o 5 é fator + valor.
 */
function linhaDigitavel(barras) {
  const c = digitos(barras);
  if (c.length !== 44) throw new ErroNegocio('Código de barras precisa ter 44 dígitos.', 422);
  const banco = c.slice(0, 3);
  const moeda = c.slice(3, 4);
  const dvGeral = c.slice(4, 5);
  const fatorValor = c.slice(5, 19);
  const livre = c.slice(19, 44);

  const c1 = `${banco}${moeda}${livre.slice(0, 5)}`;
  const c2 = livre.slice(5, 15);
  const c3 = livre.slice(15, 25);
  return `${c1}${modulo10(c1)}${c2}${modulo10(c2)}${c3}${modulo10(c3)}${dvGeral}${fatorValor}`;
}

/** Linha digitável com a pontuação que aparece no boleto. */
const formatarLinha = (linha) => {
  const l = digitos(linha);
  if (l.length !== 47) return l;
  return `${l.slice(0, 5)}.${l.slice(5, 10)} ${l.slice(10, 15)}.${l.slice(15, 21)} ${l.slice(21, 26)}.${l.slice(26, 32)} ${l.slice(32, 33)} ${l.slice(33)}`;
};

/** Código de barras de volta, a partir da linha digitável: serve para conferir o que foi emitido. */
function barrasDaLinha(linha) {
  const l = digitos(linha);
  if (l.length !== 47) throw new ErroNegocio('Linha digitável precisa ter 47 dígitos.', 422);
  const livre = `${l.slice(4, 9)}${l.slice(10, 20)}${l.slice(21, 31)}`;
  return `${l.slice(0, 4)}${l.slice(32, 33)}${l.slice(33, 47)}${livre}`;
}

/** A linha digitável confere? (os quatro dígitos verificadores) */
function conferirLinha(linha) {
  const l = digitos(linha);
  if (l.length !== 47) return false;
  if (modulo10(l.slice(0, 9)) !== Number(l[9])) return false;
  if (modulo10(l.slice(10, 20)) !== Number(l[20])) return false;
  if (modulo10(l.slice(21, 31)) !== Number(l[31])) return false;
  const barras = barrasDaLinha(l);
  return modulo11Barra(`${barras.slice(0, 4)}${barras.slice(5)}`) === Number(barras[4]);
}

/*
 * Campo livre por banco.
 *
 * `validado: false` em todos de propósito: estes são os layouts mais usados de cada banco, mas o layout
 * real depende da carteira e do convênio do contrato do provedor. Nenhum deles foi conferido contra um
 * boleto liquidado de verdade neste repositório, e o sistema diz isso na tela antes da primeira remessa.
 */
const BANCOS = {
  '001': {
    nome: 'Banco do Brasil',
    // Convênio de 7 dígitos com nosso número de 10: o layout mais comum do BB hoje.
    campoLivre: ({ convenio, nosso_numero: nn, carteira }) => `000000${zeros(convenio, 7)}${zeros(nn, 10)}${zeros(carteira, 2)}`,
    nossoNumeroDv: (nn, { convenio }) => modulo11Base9(`${zeros(convenio, 7)}${zeros(nn, 10)}`),
    observacao: 'Layout de convênio com 7 dígitos e nosso número com 10. Convênio de 6 ou 8 dígitos usa outra montagem.',
  },
  '033': {
    nome: 'Santander',
    campoLivre: ({ codigo_beneficiario: cb, nosso_numero: nn, carteira }) => `9${zeros(cb, 7)}${zeros(nn, 13)}0${zeros(carteira, 3)}`,
    nossoNumeroDv: (nn) => modulo11Base9(zeros(nn, 12)),
    observacao: 'Usa o código do beneficiário (não a conta) e o IOF fixo em zero.',
  },
  '104': {
    nome: 'Caixa Econômica Federal',
    // SIGCB: o nosso número de 17 dígitos é partido, e os dois DVs intermediários são módulo 11.
    campoLivre: ({ codigo_beneficiario: cb, nosso_numero: nn }) => {
      const c = zeros(cb, 6);
      const n = zeros(nn, 17);
      // beneficiário(6) + DV(1) + NN 3-5 + constante 1 + NN 6-8 + constante 2 + NN 9-17 + DV do campo
      // As duas constantes são os dois primeiros dígitos do nosso número (modalidade da cobrança).
      const corpo = `${c}${modulo11Base9(c)}${n.slice(2, 5)}${n.slice(0, 1)}${n.slice(5, 8)}${n.slice(1, 2)}${n.slice(8, 17)}`;
      return `${corpo}${modulo11Base9(corpo)}`;
    },
    nossoNumeroDv: (nn) => modulo11Base9(zeros(nn, 17)),
    observacao: 'Carteira SIGCB. A Caixa tem variações por tipo de cobrança (registrada, rápida).',
  },
  237: {
    nome: 'Bradesco',
    campoLivre: ({ agencia, carteira, nosso_numero: nn, conta }) => `${zeros(agencia, 4)}${zeros(carteira, 2)}${zeros(nn, 11)}${zeros(conta, 7)}0`,
    nossoNumeroDv: (nn, { carteira }) => modulo11Base9(`${zeros(carteira, 2)}${zeros(nn, 11)}`, { restoUmComoP: true }),
    observacao: 'Carteira 09 (registrada) é a mais comum. O dígito do nosso número usa P quando o resto é 1.',
  },
  341: {
    nome: 'Itaú',
    campoLivre: ({ carteira, nosso_numero: nn, agencia, conta }) => {
      const dvNn = modulo10(`${zeros(agencia, 4)}${zeros(conta, 5)}${zeros(carteira, 3)}${zeros(nn, 8)}`);
      const dvAgConta = modulo10(`${zeros(agencia, 4)}${zeros(conta, 5)}`);
      return `${zeros(carteira, 3)}${zeros(nn, 8)}${dvNn}${zeros(agencia, 4)}${zeros(conta, 5)}${dvAgConta}000`;
    },
    nossoNumeroDv: (nn, { agencia, conta, carteira }) => String(modulo10(`${zeros(agencia, 4)}${zeros(conta, 5)}${zeros(carteira, 3)}${zeros(nn, 8)}`)),
    observacao: 'Carteiras 109, 175 e 112 são as usuais. Carteiras escriturais montam o campo livre de outro jeito.',
  },
  748: {
    nome: 'Sicredi',
    campoLivre: ({ carteira, nosso_numero: nn, agencia, posto, codigo_beneficiario: cb }) => {
      const corpo = `${String(carteira ?? '1').slice(0, 1)}1${zeros(nn, 9)}${zeros(agencia, 4)}${zeros(posto ?? '0', 2)}${zeros(cb, 5)}10`;
      return `${corpo}${modulo11Base9(corpo)}`;
    },
    nossoNumeroDv: (nn) => modulo11Base9(zeros(nn, 9)),
    observacao: 'Exige o posto da cooperativa além da agência.',
  },
  756: {
    nome: 'Sicoob',
    campoLivre: ({ carteira, agencia, modalidade, codigo_beneficiario: cb, nosso_numero: nn, parcelas }) =>
      `${String(carteira ?? '1').slice(0, 1)}${zeros(agencia, 4)}${zeros(modalidade ?? '01', 2)}${zeros(cb, 7)}${zeros(nn, 8)}${zeros(parcelas ?? '001', 3)}`,
    nossoNumeroDv: (nn, { agencia, codigo_beneficiario: cb }) => modulo11Base9(`${zeros(agencia, 4)}${zeros(cb, 10)}${zeros(nn, 7)}`),
    observacao: 'Precisa da modalidade de cobrança e do número de parcelas do convênio.',
  },
  '077': {
    nome: 'Banco Inter',
    campoLivre: ({ carteira, nosso_numero: nn, codigo_beneficiario: cb }) => `${zeros(cb, 9)}${zeros(nn, 11)}${zeros(carteira, 2)}000`,
    nossoNumeroDv: (nn) => modulo11Base9(zeros(nn, 11)),
    observacao: 'O Inter trabalha principalmente por API; o boleto por arquivo exige acerto com o banco.',
  },
};

const bancos = () => Object.entries(BANCOS).map(([codigo, b]) => ({ codigo, nome: b.nome, observacao: b.observacao, validado: false }));

/**
 * Monta o boleto inteiro de uma cobrança. Devolve também `validado: false`, que a tela usa para lembrar
 * que o campo livre precisa ser conferido com o banco antes da primeira remessa em produção.
 */
function montar({ banco, valor_centavos: valor, vencimento, ...dados }) {
  const b = zeros(banco, 3);
  const layout = BANCOS[b] ?? BANCOS[String(Number(b))];
  if (!layout) throw new ErroNegocio(`Ainda não há montagem de campo livre para o banco ${b}. Os disponíveis: ${Object.keys(BANCOS).join(', ')}.`, 422);
  const campoLivre = layout.campoLivre(dados);
  const barras = codigoBarras({ banco: b, valor_centavos: valor, vencimento, campo_livre: campoLivre });
  const linha = linhaDigitavel(barras);
  return {
    banco: b,
    banco_nome: layout.nome,
    campo_livre: campoLivre,
    codigo_barras: barras,
    linha_digitavel: linha,
    linha_formatada: formatarLinha(linha),
    nosso_numero_dv: layout.nossoNumeroDv ? String(layout.nossoNumeroDv(dados.nosso_numero, dados)) : null,
    validado: false,
    observacao: layout.observacao,
  };
}

module.exports = { modulo10, modulo11Barra, modulo11Base9, fatorVencimento, vencimentoDoFator, codigoBarras,
  linhaDigitavel, formatarLinha, barrasDaLinha, conferirLinha, montar, bancos, BANCOS, zeros, digitos };
