/** Gráficos simples em SVG (sem bibliotecas externas). */
import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...filhos) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  for (const f of filhos) if (f) e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return e;
};

export const CORES = { amarelo: '#D97706', azul: '#2563EB', verde: '#16A34A', roxo: '#7C3AED', cinza: '#9CA3AF' };

/** Pizza: [{ rotulo, valor, cor }]. Mostra a legenda e o valor de cada fatia ao passar o mouse. */
export function pizza(fatias, { formato = (v) => String(v), vazio = 'Sem dados' } = {}) {
  const total = fatias.reduce((s, f) => s + (f.valor || 0), 0);
  const legenda = el('div', { class: 'legenda' }, fatias.map((f) => el('span', {}, el('i', { style: `background:${f.cor}` }), `${f.rotulo}: ${formato(f.valor || 0)}`)));
  if (!total) return el('div', { class: 'pizza' }, el('div', { class: 'vazio-grafico' }, vazio), legenda);
  // Rosca: o total no centro.
  const comCentro = (svgEl) => el('div', { class: 'pizza' }, el('div', { class: 'rosca' }, svgEl, el('div', { class: 'centro' }, el('strong', {}, formato(total)), el('span', {}, 'total'))), legenda);
  const g = svg('svg', { viewBox: '-1 -1 2 2', role: 'img', 'aria-label': fatias.map((f) => `${f.rotulo} ${formato(f.valor || 0)}`).join(', ') });
  g.style.transform = 'rotate(-90deg)';
  let acumulado = 0;
  for (const f of fatias.filter((x) => x.valor > 0)) {
    const fracao = f.valor / total;
    const titulo = svg('title', {}, `${f.rotulo}: ${formato(f.valor)} (${Math.round(fracao * 100)}%)`);
    if (fracao >= 0.9999) {
      g.append(svg('circle', { cx: 0, cy: 0, r: 1, fill: f.cor }, titulo));
      break;
    }
    const [x1, y1] = [Math.cos(2 * Math.PI * acumulado), Math.sin(2 * Math.PI * acumulado)];
    acumulado += fracao;
    const [x2, y2] = [Math.cos(2 * Math.PI * acumulado), Math.sin(2 * Math.PI * acumulado)];
    g.append(svg('path', { d: `M ${x1} ${y1} A 1 1 0 ${fracao > 0.5 ? 1 : 0} 1 ${x2} ${y2} L 0 0 Z`, fill: f.cor }, titulo));
  }
  g.append(svg('circle', { cx: 0, cy: 0, r: 0.68, class: 'furo' }));
  return comCentro(g);
}

/** Barras verticais: [{ rotulo, valor, titulo }], com o rótulo de cada uma embaixo. */
export function barras(itens) {
  const max = Math.max(1, ...itens.map((i) => i.valor));
  return el('div', {},
    el('div', { class: 'barras' }, itens.map((i) => el('div', { class: 'barra', style: `height:${Math.max(1, (i.valor / max) * 100)}%`, title: i.titulo ?? `${i.rotulo}: ${i.valor}` }))),
    el('div', { class: 'barras-rotulos' }, itens.map((i) => el('span', {}, i.rotulo))));
}

/**
 * Área com linha suave (como no visual aprovado): [{ rotulo, valor, titulo }]. Cada ponto mostra o valor ao passar o mouse;
 * o texto alternativo lista todos os valores para leitores de tela.
 */
let idGrafico = 0;
export function area(itens, { vazio = 'Sem dados no período' } = {}) {
  if (!itens.length) return el('div', { class: 'vazio-grafico' }, vazio);
  const L = 360;
  const A = 120;
  const max = Math.max(1, ...itens.map((i) => i.valor || 0));
  const passo = itens.length > 1 ? (L - 6) / (itens.length - 1) : 0;
  const pts = itens.map((i, k) => [3 + k * passo, 110 - ((i.valor || 0) / max) * 96]);
  if (pts.length === 1) pts.push([L - 3, pts[0][1]]);
  // Curva suave passando pelos pontos (Catmull-Rom convertida em Bézier).
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[k - 1] ?? pts[k];
    const p1 = pts[k];
    const p2 = pts[k + 1];
    const p3 = pts[k + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${Math.min(110, c1[1]).toFixed(1)} ${c2[0].toFixed(1)} ${Math.min(110, c2[1]).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const id = ++idGrafico;
  const fundo = `${d}L${pts.at(-1)[0].toFixed(1)} 110H${pts[0][0].toFixed(1)}Z`;
  const largura = itens.length > 1 ? passo : L;
  const g = svg('svg', { viewBox: `0 0 ${L} ${A}`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': itens.map((i) => i.titulo ?? `${i.rotulo}: ${i.valor}`).join('; ') },
  svg('defs', {},
    svg('linearGradient', { id: `area-fundo-${id}`, x1: 0, y1: 0, x2: 0, y2: 1 },
      svg('stop', { offset: 0, 'stop-color': '#218BCD', 'stop-opacity': '.18' }), svg('stop', { offset: 1, 'stop-color': '#218BCD', 'stop-opacity': 0 })),
    svg('linearGradient', { id: `area-linha-${id}` }, svg('stop', { 'stop-color': '#437BFF' }), svg('stop', { offset: 1, 'stop-color': '#16BDA5' }))),
  svg('path', { class: 'grade-linha', d: 'M0 14H360M0 46H360M0 78H360M0 110H360' }),
  svg('path', { d: fundo, fill: `url(#area-fundo-${id})` }),
  svg('path', { d, fill: 'none', stroke: `url(#area-linha-${id})`, 'stroke-width': 3, 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }),
  ...itens.map((i, k) => svg('rect', { class: 'coluna-hover', x: Math.max(0, 3 + k * passo - largura / 2), y: 0, width: largura, height: A },
    svg('title', {}, i.titulo ?? `${i.rotulo}: ${i.valor}`))));
  // Cada rótulo fica embaixo do seu ponto (o primeiro e o último encostam nas bordas).
  const posicao = (k) => (itens.length > 1 ? ((3 + k * passo) / L) * 100 : 50);
  return el('div', { class: 'grafico-area' }, g,
    el('div', { class: 'rotulos', 'aria-hidden': 'true' }, itens.map((i, k) => el('span', { style: `left:${posicao(k).toFixed(2)}%` }, i.rotulo))));
}
