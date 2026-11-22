'use strict';

/*
 * Código de barras CODE-128.
 *
 * Para que serve aqui: o DANFE-Com leva, além do QR Code, um CODE-128 com a chave de acesso de 44
 * dígitos (NT Conjunta 2025.001). Quem confere a nota no balcão passa o leitor de mão nele.
 *
 * Como a chave é só dígito, o conjunto C é o natural: ele codifica DOIS dígitos por símbolo, o que
 * deixa o código quase metade do tamanho que teria no conjunto A ou B — e a norma do DANFE exige
 * largura mínima de 11,5 cm, que já é bastante papel.
 *
 * Correção não é opinião, igual ao QR: barra errada é barra que não lê, e ninguém descobre antes do
 * balcão. Por isso o teste manda um leitor de código de barras de verdade ler a imagem gerada.
 */

/*
 * Larguras de cada símbolo, em módulos: barra, espaço, barra, espaço, barra, espaço.
 * São os 103 valores de dados, mais Start A/B/C (103, 104, 105) e o Stop (106), que tem sete elementos.
 */
const PADROES = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const INICIO_C = 105;
const PARADA = 106;

/**
 * Os valores do símbolo para um texto só de dígitos, no conjunto C.
 * Quantidade ímpar de dígitos não existe no conjunto C — é erro de quem chamou, e é dito como tal.
 */
function valores(digitos) {
  const d = String(digitos ?? '').replace(/\D/g, '');
  if (!d.length) throw new Error('Código de barras sem conteúdo.');
  if (d.length % 2 !== 0) throw new Error(`O conjunto C codifica os dígitos aos pares: ${d.length} dígitos não fecham.`);
  const vals = [INICIO_C];
  for (let i = 0; i < d.length; i += 2) vals.push(Number(d.slice(i, i + 2)));
  /*
   * Dígito de verificação: o valor de início mais cada valor de dado multiplicado pela sua posição
   * (a primeira é 1), tudo módulo 103. É o que faz o leitor recusar uma leitura suja em vez de
   * devolver uma chave trocada.
   */
  let soma = INICIO_C;
  for (let i = 1; i < vals.length; i++) soma += vals[i] * i;
  vals.push(soma % 103);
  vals.push(PARADA);
  return vals;
}

/** As larguras de barra e espaço, começando sempre por barra. */
function barras(digitos) {
  const fora = [];
  for (const v of valores(digitos)) {
    const p = PADROES[v];
    if (!p) throw new Error(`Valor ${v} fora da tabela do CODE-128.`);
    for (const largura of p) fora.push(Number(largura));
  }
  return fora;
}

/**
 * O código como SVG. `modulo` é a largura do módulo mais estreito e `altura` a do código.
 * A zona de silêncio dos dois lados é obrigatória: sem ela, muitos leitores não enxergam o começo.
 */
function svg(digitos, { modulo = 1, altura = 40, silencio = 10, cor = '#000', fundo = '#fff' } = {}) {
  const larguras = barras(digitos);
  const modulos = larguras.reduce((s, v) => s + v, 0) + silencio * 2;
  const largura = modulos * modulo;
  const partes = [];
  let x = silencio;
  larguras.forEach((w, i) => {
    if (i % 2 === 0) partes.push(`M${x * modulo} 0h${w * modulo}v${altura}h-${w * modulo}z`);
    x += w;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largura} ${altura}" width="${largura}" height="${altura}" shape-rendering="crispEdges">`
    + `<rect width="${largura}" height="${altura}" fill="${fundo}"/>`
    + `<path d="${partes.join('')}" fill="${cor}"/></svg>`;
}

module.exports = { svg, barras, valores, PADROES };
