/*
 * Gráficos do PAY AX, em SVG, sem biblioteca externa.
 *
 * Regras seguidas (paleta validada para daltonismo e contraste):
 *  - uma série não leva legenda (o título já a nomeia); duas ou mais sempre levam;
 *  - marcas finas com topo arredondado, ancoradas na linha de base, 2 px de respiro entre elas;
 *  - grade e eixos recessivos; rótulos diretos só nos pontos que importam, nunca em todos;
 *  - camada de hover com dica de valor — um gráfico em HTML é interativo por natureza;
 *  - a cor nunca informa sozinha: toda fatia da barra composta leva rótulo visível.
 */
import { el, dinheiro, dinheiroCurto, dataCurta, numero } from './ui.js';

const SERIES = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)'];
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  return e;
};

let dica = null;
function mostrarDica(evento, conteudo) {
  if (!dica) { dica = el('div', { class: 'gfx-dica' }); document.body.append(dica); }
  dica.replaceChildren(...[conteudo].flat().filter(Boolean));
  dica.style.display = 'block';
  const r = dica.getBoundingClientRect();
  const x = Math.min(window.innerWidth - r.width - 10, Math.max(10, evento.clientX - r.width / 2));
  dica.style.left = `${x}px`;
  dica.style.top = `${Math.max(10, evento.clientY - r.height - 12)}px`;
}
const esconderDica = () => { if (dica) dica.style.display = 'none'; };

/**
 * Escala do eixo com passo "redondo": o topo é um múltiplo exato do passo, para que os rótulos
 * saiam em valores limpos (R$ 200, R$ 400…) em vez de R$ 166,67.
 */
function escala(max, divisoes = 3) {
  if (max <= 0) return { topo: divisoes, passo: 1 };
  const bruto = max / divisoes;
  const exp = 10 ** Math.floor(Math.log10(bruto));
  const norm = bruto / exp;
  const passo = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * exp;
  return { topo: passo * divisoes, passo };
}

/** Rótulo do eixo: sem centavos quando o passo é redondo; abreviado a partir de mil. */
function rotuloEixo(centavos) {
  const v = centavos / 100;
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (Math.abs(v) >= 1000) return `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: centavos % 100 ? 2 : 0 })}`;
}

/**
 * Barras verticais de uma série ao longo do tempo (ex.: o que entrou por dia).
 * @param {{dados: Array<{data: string, valor: number, titulos?: number}>, altura?: number, rotuloValor?: Function}} opcoes
 */
export function barrasPorDia({ dados, altura = 170, rotuloValor = dinheiro, vazio = 'Sem movimento no período.' }) {
  if (!dados?.length || !dados.some((d) => d.valor > 0)) return el('p', { class: 'vazio' }, vazio);
  const larg = 760;
  const margem = { topo: 18, dir: 10, baixo: 24, esq: 76 };
  const areaL = larg - margem.esq - margem.dir;
  const areaA = altura - margem.topo - margem.baixo;
  const { topo: max, passo: passoEixo } = escala(Math.max(...dados.map((d) => d.valor)));
  const passo = areaL / dados.length;
  const larguraBarra = Math.max(3, Math.min(26, passo - 2)); // 2 px de respiro entre as marcas
  const maiorIndice = dados.reduce((m, d, i) => (d.valor > dados[m].valor ? i : m), 0);

  const svg = svgEl('svg', { viewBox: `0 0 ${larg} ${altura}`, width: '100%', height: altura, role: 'img',
    'aria-label': `Gráfico de barras: ${dados.length} dias, maior valor ${rotuloValor(dados[maiorIndice].valor)} em ${dataCurta(dados[maiorIndice].data)}` });

  // Grade recessiva com o eixo de valores.
  for (let i = 0; i * passoEixo <= max; i++) {
    const valor = i * passoEixo;
    const y = margem.topo + areaA - (areaA * valor) / max;
    svg.append(svgEl('line', { x1: margem.esq, x2: larg - margem.dir, y1: y, y2: y, stroke: i === 0 ? 'var(--eixo)' : 'var(--grade)', 'stroke-width': 1 }));
    const t = svgEl('text', { x: margem.esq - 8, y: y + 4, 'text-anchor': 'end', fill: 'var(--texto-3)', 'font-size': '10.5' });
    t.textContent = rotuloEixo(valor);
    svg.append(t);
  }

  dados.forEach((d, i) => {
    const h = max ? Math.max(d.valor > 0 ? 2 : 0, (d.valor / max) * areaA) : 0;
    const x = margem.esq + i * passo + (passo - larguraBarra) / 2;
    const y = margem.topo + areaA - h;
    if (h > 0) svg.append(svgEl('rect', { x, y, width: larguraBarra, height: h, rx: Math.min(4, larguraBarra / 2), fill: SERIES[0] }));
    // Alvo de hover maior que a marca.
    const alvo = svgEl('rect', { x: margem.esq + i * passo, y: margem.topo, width: passo, height: areaA, fill: 'transparent' });
    alvo.addEventListener('mouseenter', (e) => mostrarDica(e, [
      el('b', {}, dataCurta(d.data)),
      el('span', { class: 'num' }, rotuloValor(d.valor)),
      d.titulos ? el('div', {}, `${numero(d.titulos)} título(s)`) : null,
    ]));
    alvo.addEventListener('mousemove', (e) => mostrarDica(e, [
      el('b', {}, dataCurta(d.data)),
      el('span', { class: 'num' }, rotuloValor(d.valor)),
      d.titulos ? el('div', {}, `${numero(d.titulos)} título(s)`) : null,
    ]));
    alvo.addEventListener('mouseleave', esconderDica);
    svg.append(alvo);
  });

  // Rótulo direto só no maior dia e nas pontas do eixo — nunca em todos os pontos.
  const marcar = new Set([0, dados.length - 1]);
  for (const i of marcar) {
    const t = svgEl('text', { x: margem.esq + i * passo + passo / 2, y: altura - 7,
      'text-anchor': i === 0 ? 'start' : 'end', fill: 'var(--texto-3)', 'font-size': '10.5' });
    t.textContent = dataCurta(dados[i].data);
    svg.append(t);
  }
  if (dados[maiorIndice].valor > 0) {
    const h = (dados[maiorIndice].valor / max) * areaA;
    const t = svgEl('text', { x: margem.esq + maiorIndice * passo + passo / 2, y: margem.topo + areaA - h - 6,
      'text-anchor': 'middle', fill: 'var(--texto-2)', 'font-size': '11', 'font-weight': '600' });
    t.textContent = dinheiroCurto(dados[maiorIndice].valor);
    svg.append(t);
  }

  const caixa = el('div', { class: 'gfx' }, svg);
  caixa.addEventListener('mouseleave', esconderDica);
  return caixa;
}

/**
 * Barra composta do split: cada fatia leva rótulo visível, então a cor nunca informa sozinha.
 * @param {{partes: Array<{rotulo: string, valor: number}>, total: number}} opcoes
 */
export function barraSplit({ partes, total }) {
  const soma = total || partes.reduce((s, p) => s + p.valor, 0) || 1;
  const barra = el('div', { class: 'barra-composta', role: 'img',
    'aria-label': partes.map((p) => `${p.rotulo}: ${dinheiro(p.valor)}`).join('; ') });
  partes.forEach((p, i) => {
    if (p.valor <= 0) return;
    barra.append(el('span', { style: `width:${(p.valor / soma) * 100}%;background:${SERIES[i % SERIES.length]}`, title: `${p.rotulo}: ${dinheiro(p.valor)}` }));
  });
  const legenda = el('div', { class: 'gfx-legenda' }, partes.map((p, i) =>
    el('span', {}, el('i', { style: `background:${SERIES[i % SERIES.length]}` }), `${p.rotulo} `, el('strong', { class: 'num' }, dinheiro(p.valor)))));
  return el('div', {}, barra, legenda);
}

/** Linha do tempo da liberação do saldo (agenda de recebíveis). */
export function agendaLiberacao({ dados, altura = 120 }) {
  if (!dados?.length) return el('p', { class: 'vazio' }, 'Nada a liberar nos próximos dias.');
  return barrasPorDia({ dados: dados.map((d) => ({ data: d.data, valor: d.valor_centavos, titulos: d.lancamentos })), altura });
}
