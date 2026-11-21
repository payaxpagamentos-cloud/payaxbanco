/** Gráficos simples em SVG (sem bibliotecas externas). */
import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...filhos) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  for (const f of filhos) if (f) e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return e;
};

/** Paleta dos gráficos: o lime da marca na frente, grafite e tons de apoio atrás. */
export const CORES = { marca: '#9FD400', lime: '#C8FF31', grafite: '#111417', oliva: '#5A7D00', cinza: '#A8AEB8',
  amarelo: '#F59E0B', verde: '#16A34A', vermelho: '#EF4444', azul: '#2563EB' };

/** Pizza: [{ rotulo, valor, cor }]. Mostra a legenda e o valor de cada fatia ao passar o mouse. */
export function pizza(fatias, { formato = (v) => String(v), vazio = 'Sem dados', centro = null, lado = false } = {}) {
  const total = fatias.reduce((s, f) => s + (f.valor || 0), 0);
  const pct = (v) => (total ? `${(Math.round((v / total) * 1000) / 10).toLocaleString('pt-BR')}%` : '0%');
  // Ao lado: rótulo e percentual em linhas (como um resumo); embaixo: rótulo e valor.
  const legenda = lado
    ? el('div', { class: 'legenda lado' }, fatias.map((f) => el('span', {}, el('i', { style: `background:${f.cor}` }), el('em', {}, f.rotulo), el('b', { class: 'num' }, pct(f.valor || 0)))))
    : el('div', { class: 'legenda' }, fatias.map((f) => el('span', {}, el('i', { style: `background:${f.cor}` }), `${f.rotulo}: ${formato(f.valor || 0)}`)));
  if (!total) return el('div', { class: 'pizza' }, el('div', { class: 'vazio-grafico' }, vazio), lado ? null : legenda);
  const g = svg('svg', { viewBox: '-1 -1 2 2', role: 'img', 'aria-label': fatias.map((f) => `${f.rotulo} ${formato(f.valor || 0)}`).join(', ') });
  g.style.transform = 'rotate(-90deg)';
  // Anel vazado (traços sobre um círculo): o fundo do cartão aparece no meio, inclusive com o efeito vidro.
  const visiveis = fatias.filter((x) => x.valor > 0);
  const folga = visiveis.length > 1 ? 0.8 : 0; // pequeno espaço entre as fatias (em % da volta)
  g.append(svg('circle', { cx: 0, cy: 0, r: 0.82, class: 'trilho-rosca', pathLength: 100 }));
  let acumulado = 0;
  for (const f of visiveis) {
    const fracao = f.valor / total;
    const titulo = svg('title', {}, `${f.rotulo}: ${formato(f.valor)} (${Math.round(fracao * 100)}%)`);
    const tamanho = Math.max(0.01, fracao * 100 - folga);
    g.append(svg('circle', {
      cx: 0, cy: 0, r: 0.82, fill: 'none', stroke: f.cor, 'stroke-width': 0.3, pathLength: 100,
      'stroke-dasharray': `${tamanho} ${100 - tamanho}`, 'stroke-dashoffset': -acumulado * 100, class: 'fatia',
    }, titulo));
    acumulado += fracao;
  }
  const rosca = el('div', { class: 'rosca' }, g, centro ? el('div', { class: 'centro' }, el('strong', { class: 'num' }, centro.valor), el('small', {}, centro.rotulo)) : null);
  return el('div', { class: `pizza${lado ? ' lado' : ''}` }, rosca, legenda);
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
  const g = svg('svg', { viewBox: `0 0 ${L} ${A}`, class: 'grafico', role: 'img', 'aria-label': 'Inserções ao longo do dia' });
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
      g.append(svg('circle', { cx: x(i), cy: y(v), r: 6, fill: 'transparent' }, svg('title', {}, `${horario(i * passoMin)}–${horario((i + 1) * passoMin)}: ${v} inserções`)));
    }
  }
  return g;
}

/** Barras lado a lado por período: [{ rotulo, a, b }] — para comparar o que entra com o que sai. */
export function barrasComparadas(itens, { rotuloA = 'Entrou', rotuloB = 'Saiu', formato = (v) => String(v) } = {}) {
  const max = Math.max(1, ...itens.flatMap((i) => [i.a, i.b]));
  const altura = (v) => `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%`;
  return el('div', { class: 'coluna' },
    el('div', { class: 'barras duplas' }, itens.map((i) => el('div', { class: 'par' },
      el('div', { class: 'colunas' },
        el('div', { class: 'barra', style: `height:${altura(i.a)}`, title: `${i.rotulo} — ${rotuloA}: ${formato(i.a)}` }),
        el('div', { class: 'barra saida', style: `height:${altura(i.b)}`, title: `${i.rotulo} — ${rotuloB}: ${formato(i.b)}` })),
      el('div', { class: 'eixo' }, i.rotulo)))),
    el('div', { class: 'legenda' },
      el('span', {}, el('i', { style: `background:${CORES.marca}` }), rotuloA),
      el('span', {}, el('i', { class: 'saida' }), rotuloB)));
}

/** Barras verticais: [{ rotulo, valor, titulo }]. */
export function barras(itens) {
  const max = Math.max(1, ...itens.map((i) => i.valor));
  return el('div', { class: 'barras' }, itens.map((i) => el('div', { class: 'barra', style: `height:${Math.max(1, (i.valor / max) * 100)}%`, title: i.titulo ?? `${i.rotulo}: ${i.valor}` })));
}
