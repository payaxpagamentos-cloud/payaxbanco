'use strict';

/*
 * Construtor de XML para documentos fiscais.
 *
 * A ideia central: gerar o XML JÁ NA FORMA CANÔNICA (C14N 1.0). Assim a transformação de canonicalização
 * exigida pela assinatura vira uma operação vazia — o que está no arquivo é exatamente o que entra no
 * resumo criptográfico. Isso evita a classe de bug mais traiçoeira da assinatura de documento fiscal:
 * assinar uma coisa e transmitir outra, porque algum serializador reordenou atributo, trocou `<a/>` por
 * `<a></a>` ou mexeu num espaço em branco.
 *
 * O que a forma canônica exige, e que este módulo cumpre por construção:
 *   - UTF-8, sem declaração XML dentro do trecho assinado;
 *   - elemento vazio sempre escrito como <a></a>, nunca <a/>;
 *   - atributos em ordem: declarações de namespace primeiro, depois por nome;
 *   - escape de & < > nos textos, e de & < " tab, LF e CR nos atributos;
 *   - nenhum espaço em branco entre tags que não esteja no conteúdo.
 */

/** Escape de conteúdo de elemento. O ">" também é escapado: a C14N exige. */
const escapar = (texto) => String(texto)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\r/g, '&#xD;');

/** Escape de valor de atributo. Aqui o ">" NÃO é escapado, e os brancos viram referência numérica. */
const escaparAtributo = (texto) => String(texto)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/"/g, '&quot;')
  .replace(/\t/g, '&#x9;')
  .replace(/\n/g, '&#xA;')
  .replace(/\r/g, '&#xD;');

/*
 * Ordem canônica dos atributos: as declarações de namespace vêm antes de tudo (xmlns puro antes de
 * xmlns:prefixo), e o resto em ordem de nome. A comparação é por ponto de código, não alfabética da
 * língua — "Id" vem antes de "versao" porque "I" maiúsculo vem antes de "v" minúsculo.
 */
function ordenarAtributos(attrs) {
  const entradas = Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null);
  const ns = entradas.filter(([k]) => k === 'xmlns' || k.startsWith('xmlns:'));
  const resto = entradas.filter(([k]) => k !== 'xmlns' && !k.startsWith('xmlns:'));
  ns.sort(([a], [b]) => (a === 'xmlns' ? -1 : b === 'xmlns' ? 1 : (a < b ? -1 : a > b ? 1 : 0)));
  resto.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [...ns, ...resto];
}

const comAtributos = (attrs) => ordenarAtributos(attrs).map(([k, v]) => ` ${k}="${escaparAtributo(v)}"`).join('');

/**
 * Elemento com texto. Devolve string vazia quando o valor é nulo ou vazio — assim um campo opcional
 * simplesmente não aparece, que é o que o leiaute espera. O zero NÃO é vazio e é emitido.
 */
function tag(nome, valor, attrs = {}) {
  if (valor === null || valor === undefined || valor === '') return '';
  return `<${nome}${comAtributos(attrs)}>${escapar(valor)}</${nome}>`;
}

/**
 * Grupo com filhos. Sem filhos, o grupo some (grupo opcional vazio não vai para o XML).
 * `sempre: true` força a emissão de um grupo obrigatório ainda que vazio.
 */
function grupo(nome, filhos, { attrs = {}, sempre = false } = {}) {
  const corpo = [].concat(filhos).flat(Infinity).filter((x) => x !== null && x !== undefined && x !== '').join('');
  if (!corpo && !sempre) return '';
  return `<${nome}${comAtributos(attrs)}>${corpo}</${nome}>`;
}

/** Documento completo, com a declaração XML que a transmissão exige. */
const documento = (corpo) => `<?xml version="1.0" encoding="UTF-8"?>${corpo}`;

/* ------------------------------------------------------------------ *
 * Formatação dos valores, como o leiaute pede.
 * ------------------------------------------------------------------ */

/** Centavos inteiros viram "1234.56": ponto decimal, sem separador de milhar, sempre 2 casas. */
function valor(centavos) {
  if (centavos === null || centavos === undefined) return null;
  const n = Math.round(Number(centavos));
  const sinal = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sinal}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Percentual com 2 casas: 18 vira "18.00". Aceita string já formatada. */
function percentual(p) {
  if (p === null || p === undefined || p === '') return null;
  return Number(p).toFixed(2);
}

/** Quantidade com 4 casas, como o leiaute aceita para qFaturada. */
function quantidade(q) {
  if (q === null || q === undefined || q === '') return null;
  return Number(q).toFixed(4);
}

/**
 * Data e hora com fuso, no formato AAAA-MM-DDTHH:MM:SS-03:00.
 * O leiaute só aceita deslocamento em horas cheias, então o fuso entra como número de horas.
 */
function dataHora(iso, horasFuso = -3) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const deslocado = new Date(d.getTime() + horasFuso * 3600_000);
  const p = (n, t = 2) => String(n).padStart(t, '0');
  const sinal = horasFuso < 0 ? '-' : '+';
  return `${deslocado.getUTCFullYear()}-${p(deslocado.getUTCMonth() + 1)}-${p(deslocado.getUTCDate())}`
    + `T${p(deslocado.getUTCHours())}:${p(deslocado.getUTCMinutes())}:${p(deslocado.getUTCSeconds())}`
    + `${sinal}${p(Math.abs(horasFuso))}:00`;
}

/**
 * Texto de campo livre (ER48): sem espaço no começo nem no fim, sem quebra de linha, cortado no tamanho
 * máximo. Cortar é melhor do que ser recusado pela SEFAZ por um caractere a mais num nome comprido.
 */
function texto(valorBruto, maximo) {
  if (valorBruto === null || valorBruto === undefined) return null;
  const limpo = String(valorBruto).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  return maximo ? limpo.slice(0, maximo) : limpo;
}

/** Só os dígitos, com tamanho fixo à esquerda (CNPJ, CEP, código de município). */
const digitos = (v, tamanho) => {
  const n = String(v ?? '').replace(/\D/g, '');
  if (!n) return null;
  return tamanho ? n.padStart(tamanho, '0').slice(-tamanho) : n;
};

module.exports = { escapar, escaparAtributo, tag, grupo, documento, valor, percentual, quantidade, dataHora, texto, digitos, ordenarAtributos };
