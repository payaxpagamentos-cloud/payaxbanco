/**
 * Gráficos em SVG, sem biblioteca.
 * - graficoLinhas: um eixo Y, linhas de 2 px, grade discreta, áreas (uma, todas ou empilhadas), linha de referência opcional,
 *   legenda simples ou em tabela (média, máximo, atual) e camada de leitura (linha vertical + caixa com os valores do ponto
 *   sob o cursor ou o teclado). Clicar num item da legenda isola a série (como no Grafana).
 * - minigrafico: linha de tendência para os quadros de número.
 * - medidor: arco de uso com faixas de atenção.
 * series: [{ nome, cor: 'var(--s1)', pontos: [[ms, valor], ...] }]
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

export function graficoLinhas({ series: todasSeries, altura = 240, formatoY = String, formatoX = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  referencia = null, area = true, preencher = null, empilhado = false, legendaTabela = false, largura = 800, vazio = 'Sem dados no período.' }) {
  const caixa = el('div', { class: 'grafico-caixa' });
  let isolada = null;
  const desenhar = () => {
    const series = isolada === null ? todasSeries : todasSeries.filter((x) => x.nome === isolada);
    caixa.replaceChildren(...montar(series));
  };
  const montar = (series) => {
    const todos = series.flatMap((x) => x.pontos);
    if (!todos.length) return [el('div', { class: 'vazio' }, el('strong', {}, vazio))];
    const L = largura; const E = largura < 600 ? 62 : 70; const D = 12; const T = 12; const B = 26;
    const w = L - E - D; const h = altura - T - B;
    const x0 = Math.min(...todos.map((p) => p[0]));
    const x1 = Math.max(...todos.map((p) => p[0]), x0 + 1);
    // Empilhado: cada série desenhada sobre a soma das anteriores (mesmos instantes).
    const acumulado = new Map();
    const desenho = series.map((x) => ({ ...x, base: x.pontos.map((p) => acumulado.get(p[0]) ?? 0), topo: x.pontos.map((p) => {
      if (!empilhado) return p[1];
      const v = (acumulado.get(p[0]) ?? 0) + p[1];
      acumulado.set(p[0], v);
      return v;
    }) }));
    if (!empilhado) desenho.forEach((d) => { d.base = d.pontos.map(() => 0); });
    // A linha de referência (ex.: capacidade) só entra na escala se estiver perto dos dados; longe, ela achataria o gráfico.
    const maxSerie = Math.max(...desenho.flatMap((d) => d.topo));
    const refVisivel = referencia && referencia.valor <= Math.max(maxSerie, 1) * 1.6 ? referencia : null;
    const max = teto(Math.max(maxSerie, refVisivel?.valor ?? 0) * 1.05);
    const px = (t) => E + ((t - x0) / (x1 - x0)) * w;
    const py = (v) => T + h - (v / max) * h;
    const svg = s('svg', { viewBox: `0 0 ${L} ${altura}`, class: 'grafico', role: 'img', 'aria-label': series.map((x) => x.nome).join(', ') });
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      svg.append(s('line', { x1: E, x2: L - D, y1: py(v), y2: py(v), class: 'grade-linha' }));
      const t = s('text', { x: E - 8, y: py(v) + 4, 'text-anchor': 'end', class: 'eixo' }); t.textContent = formatoY(v); svg.append(t);
    }
    for (let i = 0; i <= 4; i++) {
      const tx = x0 + ((x1 - x0) / 4) * i;
      const t = s('text', { x: px(tx), y: altura - 6, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'eixo' }); t.textContent = formatoX(tx); svg.append(t);
    }
    if (refVisivel) {
      svg.append(s('line', { x1: E, x2: L - D, y1: py(refVisivel.valor), y2: py(refVisivel.valor), class: 'referencia' }));
      const t = s('text', { x: L - D - 4, y: py(refVisivel.valor) - 5, 'text-anchor': 'end', class: 'eixo referencia-texto' }); t.textContent = refVisivel.rotulo; svg.append(t);
    }
    const modo = preencher ?? (empilhado ? 'todas' : area ? 'primeira' : 'nenhuma');
    for (const [i, d] of desenho.entries()) {
      if (!d.pontos.length) continue;
      const linha = d.pontos.map((p, j) => `${j ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(d.topo[j]).toFixed(1)}`).join('');
      if (modo === 'todas' || (modo === 'primeira' && i === 0)) {
        const volta = d.pontos.map((p, j) => [px(p[0]), py(d.base[j])]).reverse().map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join('');
        svg.append(s('path', { d: `${linha}${volta}Z`, fill: d.cor, 'fill-opacity': empilhado ? 0.55 : 0.12 }));
      }
      svg.append(s('path', { d: linha, fill: 'none', stroke: d.cor, 'stroke-width': empilhado ? 1.5 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
    }
    // Camada de leitura
    const cruz = s('line', { y1: T, y2: T + h, class: 'cruz', visibility: 'hidden' });
    const marcas = desenho.map((x) => s('circle', { r: 4.5, fill: x.cor, class: 'marca-ponto', 'stroke-width': 2, visibility: 'hidden' }));
    svg.append(cruz, ...marcas);
    const dica = el('div', { class: 'dica-grafico', hidden: true, role: 'status' });
    const tempos = [...new Set(todos.map((p) => p[0]))].sort((a, b) => a - b);
    const mostrar = (t) => {
      const x = px(t);
      cruz.setAttribute('x1', x); cruz.setAttribute('x2', x); cruz.setAttribute('visibility', 'visible');
      const linhas = desenho.map((d, i) => {
        const j = d.pontos.findIndex((q) => q[0] === t);
        if (j < 0) { marcas[i].setAttribute('visibility', 'hidden'); return null; }
        marcas[i].setAttribute('cx', px(t)); marcas[i].setAttribute('cy', py(d.topo[j])); marcas[i].setAttribute('visibility', 'visible');
        return [d.pontos[j][1], el('div', {}, el('span', { class: 'chave', style: `background:${d.cor}` }), `${d.nome}: `, el('strong', {}, formatoY(d.pontos[j][1])))];
      }).filter(Boolean);
      if (empilhado) linhas.reverse();
      const total = empilhado && linhas.length > 1 ? [el('div', { class: 'dica-total' }, 'Total: ', el('strong', {}, formatoY(linhas.reduce((a, l) => a + l[0], 0))))] : [];
      dica.replaceChildren(el('div', { class: 'fraco' }, formatoX(t)), ...linhas.map((l) => l[1]), ...total);
      dica.hidden = false;
      dica.style.left = `${Math.min(Math.max((x / L) * 100, 10), 80)}%`;
    };
    const esconder = () => { cruz.setAttribute('visibility', 'hidden'); marcas.forEach((m) => m.setAttribute('visibility', 'hidden')); dica.hidden = true; };
    const maisPerto = (ev) => {
      const r = svg.getBoundingClientRect();
      const t = x0 + ((((ev.clientX - r.left) / r.width) * L - E) / w) * (x1 - x0);
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
    return [el('div', { class: 'grafico-area' }, svg, dica), legenda()];
  };
  const isolar = (nome) => { isolada = isolada === nome ? null : nome; desenhar(); };
  const legenda = () => {
    if (todasSeries.length < 2 && !legendaTabela) return null;
    const ativa = (x) => isolada === null || isolada === x.nome;
    if (!legendaTabela) {
      return el('div', { class: 'legenda' }, todasSeries.map((x) => el('button', { type: 'button', class: `item-legenda${ativa(x) ? '' : ' apagado'}`, onclick: () => isolar(x.nome),
        title: 'Clique para isolar a série' }, el('span', { class: 'chave', style: `background:${x.cor}` }), x.nome)));
    }
    const est = (x) => {
      const v = x.pontos.map((p) => p[1]);
      return v.length ? [v.reduce((a, b) => a + b, 0) / v.length, Math.max(...v), v.at(-1)] : [null, null, null];
    };
    return el('table', { class: 'legenda-tabela' },
      el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', { class: 'num' }, 'Média'), el('th', { class: 'num' }, 'Máx.'), el('th', { class: 'num' }, 'Atual'))),
      el('tbody', {}, todasSeries.map((x) => {
        const [m, mx, at] = est(x);
        return el('tr', { class: ativa(x) ? '' : 'apagado' },
          el('td', {}, el('button', { type: 'button', class: 'item-legenda', onclick: () => isolar(x.nome), title: 'Clique para isolar a série' }, el('span', { class: 'chave', style: `background:${x.cor}` }), x.nome)),
          el('td', { class: 'num' }, m === null ? '—' : formatoY(m)), el('td', { class: 'num' }, mx === null ? '—' : formatoY(mx)), el('td', { class: 'num' }, at === null ? '—' : formatoY(at)));
      })));
  };
  desenhar();
  return caixa;
}

/** Linha de tendência compacta (sem eixos), para os quadros de número. */
export function minigrafico(pontos, cor = 'var(--s1)') {
  const svg = s('svg', { viewBox: '0 0 200 40', class: 'minigrafico', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  if (pontos.length < 2) return svg;
  const t0 = pontos[0][0]; const t1 = pontos.at(-1)[0] || t0 + 1;
  const max = Math.max(...pontos.map((p) => p[1])) || 1;
  const d = pontos.map((p, i) => `${i ? 'L' : 'M'}${(((p[0] - t0) / (t1 - t0 || 1)) * 200).toFixed(1)},${(38 - (p[1] / max) * 34).toFixed(1)}`).join('');
  svg.append(s('path', { d: `${d}L200,40L0,40Z`, fill: cor, 'fill-opacity': 0.18 }),
    s('path', { d, fill: 'none', stroke: cor, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
  return svg;
}

/** Medidor em arco (0 a 100%), com faixas de atenção em 70% e 90%. */
export function medidor(fracao, { rotulo = '', texto = null } = {}) {
  const f = Math.max(0, Math.min(1, fracao ?? 0));
  const cx = 100; const cy = 100; const r = 78;
  const ponto = (a) => [cx + r * Math.cos(Math.PI * (1 - a)), cy - r * Math.sin(Math.PI * (1 - a))];
  const arco = (a, b) => { const [x1, y1] = ponto(a); const [x2, y2] = ponto(b); return `M${x1.toFixed(1)},${y1.toFixed(1)}A${r},${r} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}`; };
  const cor = f >= 0.9 ? 'var(--estado-critico)' : f >= 0.7 ? 'var(--estado-atencao)' : 'var(--estado-ok)';
  const svg = s('svg', { viewBox: '0 0 200 118', class: 'medidor', role: 'img', 'aria-label': `${rotulo} ${Math.round(f * 100)}%` });
  svg.append(s('path', { d: arco(0, 1), class: 'medidor-fundo', fill: 'none', 'stroke-width': 16, 'stroke-linecap': 'round' }));
  if (f > 0.001) svg.append(s('path', { d: arco(0, f), stroke: cor, fill: 'none', 'stroke-width': 16, 'stroke-linecap': 'round' }));
  for (const m of [0.7, 0.9]) { const [x, y] = ponto(m); const [xi, yi] = [cx + (r - 13) * Math.cos(Math.PI * (1 - m)), cy - (r - 13) * Math.sin(Math.PI * (1 - m))]; svg.append(s('line', { x1: xi, y1: yi, x2: x, y2: y, class: 'medidor-marca' })); }
  const t = s('text', { x: cx, y: cy - 8, 'text-anchor': 'middle', class: 'medidor-valor' }); t.textContent = texto ?? `${Math.round(f * 100)}%`;
  svg.append(t);
  return svg;
}
