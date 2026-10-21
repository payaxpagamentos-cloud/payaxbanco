/** Gráficos simples em SVG (sem bibliotecas externas). */
import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...filhos) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  for (const f of filhos) if (f) e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return e;
};

export const CORES = { amarelo: '#F2C318', azul: '#0F6EA8', verde: '#20A852', roxo: '#8E6CEF', cinza: '#7C8392' };

/** Pizza: [{ rotulo, valor, cor }]. Mostra a legenda e o valor de cada fatia ao passar o mouse. */
export function pizza(fatias, { formato = (v) => String(v), vazio = 'Sem dados' } = {}) {
  const total = fatias.reduce((s, f) => s + (f.valor || 0), 0);
  const legenda = el('div', { class: 'legenda' }, fatias.map((f) => el('span', {}, el('i', { style: `background:${f.cor}` }), `${f.rotulo}: ${formato(f.valor || 0)}`)));
  if (!total) return el('div', { class: 'pizza' }, el('div', { class: 'vazio-grafico' }, vazio), legenda);
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
  return el('div', { class: 'pizza' }, g, legenda);
}

/**
 * Linha do dia: `pontos` a cada `passoMin` minutos a partir da meia-noite. Pontos nulos (futuro) não são desenhados.
 */
export function linhaDoDia(pontos, { passoMin = 15 } = {}) {
  const L = 640, A = 260, mE = 36, mD = 22, mT = 12, mB = 34;
  const validos = pontos.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  const max = Math.max(2, ...validos.map(([, v]) => v));
  const passoY = max <= 5 ? 1 : Math.ceil(max / 4);
  const topo = Math.ceil(max / passoY) * passoY;
  const x = (i) => mE + (i / Math.max(1, pontos.length - 1)) * (L - mE - mD);
  const y = (v) => mT + (1 - v / topo) * (A - mT - mB);
  const g = svg('svg', { viewBox: `0 0 ${L} ${A}`, class: 'grafico', role: 'img', 'aria-label': 'Chamadas simultâneas ao longo do dia' });
  for (let v = 0; v <= topo; v += passoY) {
    g.append(svg('line', { x1: mE, x2: L - mD, y1: y(v), y2: y(v), class: 'grade-linha' }), svg('text', { x: mE - 8, y: y(v) + 6, 'text-anchor': 'end' }, v));
  }
  // O dia começa à meia-noite no fuso do sistema: os horários contam a partir dela (não dependem do fuso do navegador).
  const horario = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const porHora = 60 / passoMin;
  for (let h = 0; h < 24; h += 3) {
    g.append(svg('text', { x: x(h * porHora), y: A - 6, 'text-anchor': h === 0 ? 'start' : 'middle' }, horario(h * 60)));
  }
  if (validos.length) {
    const d = validos.map(([i, v], k) => `${k ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const ultimo = validos.at(-1)[0];
    g.append(svg('path', { d: `${d} L ${x(ultimo)} ${y(0)} L ${x(validos[0][0])} ${y(0)} Z`, class: 'area' }), svg('path', { d, class: 'serie' }));
    for (const [i, v] of validos) {
      if (!v) continue;
      g.append(svg('circle', { cx: x(i), cy: y(v), r: 6, fill: 'transparent' }, svg('title', {}, `${horario(i * passoMin)}–${horario((i + 1) * passoMin)}: ${v} simultânea(s)`)));
    }
  }
  return g;
}

/** Barras verticais: [{ rotulo, valor, titulo }]. */
export function barras(itens) {
  const max = Math.max(1, ...itens.map((i) => i.valor));
  return el('div', { class: 'barras' }, itens.map((i) => el('div', { class: 'barra', style: `height:${Math.max(1, (i.valor / max) * 100)}%`, title: i.titulo ?? `${i.rotulo}: ${i.valor}` })));
}
