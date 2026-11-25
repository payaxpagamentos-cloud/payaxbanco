/**
 * Ícones de traço da tela de entrada.
 *
 * O resto do app usa ícones preenchidos (`icone()` em ui.js, um <path> só). O desenho aprovado
 * da entrada usa traço fino com várias formas por ícone, então eles moram aqui, separados, em
 * vez de distorcer o conjunto do app.
 */

const SVG = 'http://www.w3.org/2000/svg';

// Cada forma é [tag, atributos]. O traço e a cor vêm do CSS (.icon), não daqui.
const ICONES = {
  tv: { caixa: '0 0 48 44', formas: [
    ['rect', { x: 3, y: 4, width: 40, height: 29, rx: 6 }],
    ['path', { d: 'M16 40h16' }],
    ['path', { class: 'logo-play', fill: '#ed0018', stroke: 'none', d: 'm20 12 12 7-12 7z' }],
  ] },
  play: { formas: [['path', { d: 'm7 3 15 9L7 21z' }]] },
  mail: { formas: [
    ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }],
    ['path', { d: 'm4 7 8 6 8-6' }],
  ] },
  lock: { formas: [
    ['rect', { x: 5, y: 10, width: 14, height: 11, rx: 2 }],
    ['path', { d: 'M8 10V7a4 4 0 0 1 8 0v3m-4 5v2' }],
  ] },
  eye: { formas: [
    ['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ] },
  'eye-off': { formas: [['path', { d: 'm3 3 18 18M10.6 5.1A12 12 0 0 1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.1 3.9M6.4 6.4A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.6-1.4M10 10a3 3 0 0 0 4 4' }]] },
  arrow: { formas: [['path', { d: 'M4 12h16m-7-7 7 7-7 7' }]] },
  help: { formas: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M9.8 9a2.3 2.3 0 1 1 3.5 2c-1.3.7-1.3 1.2-1.3 2m0 3h.01' }],
  ] },
  pause: { formas: [['path', { d: 'M8 5v14m8-14v14' }]] },
  'chevron-left': { formas: [['path', { d: 'm15 6-6 6 6 6' }]] },
  'chevron-right': { formas: [['path', { d: 'm9 6 6 6-6 6' }]] },
  film: { formas: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
    ['path', { d: 'M7 3v18M17 3v18M3 8h4m-4 8h4M17 8h4m-4 8h4' }],
  ] },
};

/** Monta o ícone de traço pelo nome. Nome desconhecido devolve um SVG vazio, nunca quebra a tela. */
export function iconeLinha(nome) {
  const svg = document.createElementNS(SVG, 'svg');
  const def = ICONES[nome];
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', def?.caixa ?? '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of def?.formas ?? []) {
    const forma = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) forma.setAttribute(k, String(v));
    svg.append(forma);
  }
  return svg;
}
