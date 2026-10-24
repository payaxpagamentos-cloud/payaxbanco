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
