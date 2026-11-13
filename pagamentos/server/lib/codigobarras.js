'use strict';

/**
 * Código de barras Interleaved 2 of 5 (o padrão da ficha de compensação), desenhado em SVG.
 * Cada par de dígitos vira 5 barras (do primeiro dígito) intercaladas com 5 espaços (do segundo).
 * Barra/espaço estreito = 1 módulo; largo = 3 módulos — a proporção que os leitores de boleto esperam.
 */
const PADROES = {
  0: 'NNWWN', 1: 'WNNNW', 2: 'NWNNW', 3: 'WWNNN', 4: 'NNWNW',
  5: 'WNWNN', 6: 'NWWNN', 7: 'NNNWW', 8: 'WNNWN', 9: 'NWNWN',
};

/** Sequência de larguras alternando barra/espaço, começando por barra. */
function larguras(digitos) {
  const d = String(digitos).replace(/\D/g, '');
  const num = d.length % 2 ? `0${d}` : d;
  const saida = [1, 1, 1, 1]; // início: barra-espaço-barra-espaço estreitos
  for (let i = 0; i < num.length; i += 2) {
    const barras = PADROES[num[i]];
    const espacos = PADROES[num[i + 1]];
    if (!barras || !espacos) throw new Error('Código de barras aceita apenas dígitos.');
    for (let j = 0; j < 5; j++) {
      saida.push(barras[j] === 'W' ? 3 : 1);
      saida.push(espacos[j] === 'W' ? 3 : 1);
    }
  }
  saida.push(3, 1, 1); // fim: barra larga, espaço estreito, barra estreita
  return saida;
}

/** SVG do código de barras. `altura` em pixels; o módulo tem 1 unidade de largura no viewBox. */
function svg(digitos, { altura = 50, modulo = 1, cor = '#000' } = {}) {
  const w = larguras(digitos);
  const total = w.reduce((s, x) => s + x, 0);
  let x = 0;
  const barras = [];
  w.forEach((largura, i) => {
    if (i % 2 === 0) barras.push(`<rect x="${x}" y="0" width="${largura}" height="${altura}"/>`);
    x += largura;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${altura}" width="${total * modulo}" height="${altura}" `
    + `preserveAspectRatio="none" fill="${cor}" role="img" aria-label="Código de barras do boleto">${barras.join('')}</svg>`;
}

module.exports = { svg, larguras };
