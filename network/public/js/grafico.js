/**
 * Gráfico de linhas em SVG, sem biblioteca: um eixo Y, linhas de 2 px, grade discreta, legenda, linha de referência opcional
 * (limite) e camada de leitura (linha vertical + caixa com os valores do ponto sob o cursor ou o teclado).
 * series: [{ nome, cor: 'var(--verde)', pontos: [[ms, valor], ...] }]
 */
import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v); return e; };

/** Arredonda o máximo do eixo para um número "redondo" (1, 2, 2,5, 5 × 10^n). */
function teto(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
}

export function graficoLinhas({ series, altura = 240, formatoY = String, formatoX = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  referencia = null, area = true, vazio = 'Sem dados no período.' }) {
  const todos = series.flatMap((x) => x.pontos);
  if (!todos.length) return el('div', { class: 'vazio' }, el('strong', {}, vazio));
  const L = 800; const E = 64; const D = 12; const T = 12; const B = 26;
  const w = L - E - D; const h = altura - T - B;
  const x0 = Math.min(...todos.map((p) => p[0]));
  const x1 = Math.max(...todos.map((p) => p[0]), x0 + 1);
  const max = teto(Math.max(...todos.map((p) => p[1]), referencia?.valor ?? 0) * 1.05);
  const px = (t) => E + ((t - x0) / (x1 - x0)) * w;
  const py = (v) => T + h - (v / max) * h;
  const svg = s('svg', { viewBox: `0 0 ${L} ${altura}`, class: 'grafico', role: 'img', 'aria-label': series.map((x) => x.nome).join(' e ') });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.append(s('line', { x1: E, x2: L - D, y1: py(v), y2: py(v), class: 'grade-linha' }));
    const t = s('text', { x: E - 8, y: py(v) + 4, 'text-anchor': 'end', class: 'eixo' }); t.textContent = formatoY(v); svg.append(t);
  }
  for (let i = 0; i <= 4; i++) {
    const tx = x0 + ((x1 - x0) / 4) * i;
    const t = s('text', { x: px(tx), y: altura - 6, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'eixo' }); t.textContent = formatoX(tx); svg.append(t);
  }
  if (referencia) {
    svg.append(s('line', { x1: E, x2: L - D, y1: py(referencia.valor), y2: py(referencia.valor), class: 'referencia' }));
    const t = s('text', { x: L - D - 4, y: py(referencia.valor) - 5, 'text-anchor': 'end', class: 'eixo referencia-texto' }); t.textContent = referencia.rotulo; svg.append(t);
  }
  for (const [i, x] of series.entries()) {
    if (!x.pontos.length) continue;
    const d = x.pontos.map((p, j) => `${j ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join('');
    if (area && i === 0) svg.append(s('path', { d: `${d}L${px(x.pontos.at(-1)[0]).toFixed(1)},${T + h}L${px(x.pontos[0][0]).toFixed(1)},${T + h}Z`, fill: x.cor, 'fill-opacity': 0.08 }));
    svg.append(s('path', { d, fill: 'none', stroke: x.cor, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
  }
  // Camada de leitura
  const cruz = s('line', { y1: T, y2: T + h, class: 'cruz', visibility: 'hidden' });
  const marcas = series.map((x) => s('circle', { r: 4.5, fill: x.cor, stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }));
  svg.append(cruz, ...marcas);
  const dica = el('div', { class: 'dica-grafico', hidden: true, role: 'status' });
  const tempos = [...new Set(todos.map((p) => p[0]))].sort((a, b) => a - b);
  const mostrar = (t) => {
    const x = px(t);
    cruz.setAttribute('x1', x); cruz.setAttribute('x2', x); cruz.setAttribute('visibility', 'visible');
    const linhas = series.map((sr, i) => {
      const p = sr.pontos.reduce((m, q) => (Math.abs(q[0] - t) < Math.abs(m[0] - t) ? q : m), sr.pontos[0] ?? [t, null]);
      if (p[1] === null) { marcas[i].setAttribute('visibility', 'hidden'); return null; }
      marcas[i].setAttribute('cx', px(p[0])); marcas[i].setAttribute('cy', py(p[1])); marcas[i].setAttribute('visibility', 'visible');
      return el('div', {}, el('span', { class: 'chave', style: `background:${sr.cor}` }), `${sr.nome}: `, el('strong', {}, formatoY(p[1])));
    });
    dica.replaceChildren(el('div', { class: 'fraco' }, formatoX(t)), ...linhas.filter(Boolean));
    dica.hidden = false;
    dica.style.left = `${Math.min(Math.max((x / L) * 100, 8), 78)}%`;
  };
  const esconder = () => { cruz.setAttribute('visibility', 'hidden'); marcas.forEach((m) => m.setAttribute('visibility', 'hidden')); dica.hidden = true; };
  const maisPerto = (ev) => {
    const r = svg.getBoundingClientRect();
    const t = x0 + (((ev.clientX - r.left) / r.width) * L - E) / w * (x1 - x0);
    return tempos.reduce((m, q) => (Math.abs(q - t) < Math.abs(m - t) ? q : m), tempos[0]);
  };
  let idx = tempos.length - 1;
  svg.addEventListener('pointermove', (ev) => { const t = maisPerto(ev); idx = tempos.indexOf(t); mostrar(t); });
  svg.addEventListener('pointerleave', esconder);
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') idx = Math.max(0, idx - 1); else if (ev.key === 'ArrowRight') idx = Math.min(tempos.length - 1, idx + 1); else return;
    ev.preventDefault();
    mostrar(tempos[idx]);
  });
  svg.addEventListener('blur', esconder);
  const legenda = series.length > 1 ? el('div', { class: 'legenda' }, series.map((x) => el('span', {}, el('span', { class: 'chave', style: `background:${x.cor}` }), x.nome))) : null;
  return el('div', { class: 'grafico-caixa' }, legenda, el('div', { class: 'grafico-area' }, svg, dica));
}
