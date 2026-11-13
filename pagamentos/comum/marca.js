/*
 * Marca PAY AX, desenhada em vetor para funcionar em qualquer tamanho e sobre qualquer fundo.
 *
 * O logotipo tem três elementos: o letreiro PAYAX (PAY sólido, AX em degradê), o anel luminoso
 * e as faixas diagonais do fundo. Aqui estão os dois primeiros; as faixas ficam no CSS, porque são
 * fundo de tela, não parte do letreiro.
 *
 * As letras são reconstrução geométrica a partir do logotipo. Se o arquivo vetorial original
 * (.svg/.ai do designer) estiver disponível, trocar as medidas de LETRAS aqui coloca o desenho
 * oficial no lugar — nada mais no sistema muda.
 */
const SVG = 'http://www.w3.org/2000/svg';
let sequencia = 0;

/** Letreiro desenhado numa altura de maiúscula de 100, cada letra com a sua largura e posição. */
const LETRAS = [
  // P — haste e bojo angular, com o contorno interno vazado.
  { x: 0, largura: 72, d: 'M0 0 H56 L72 16 V38 L56 54 H23 V100 H0 Z M23 14 V40 H49 L58 31 V23 L49 14 Z' },
  // A — ápice achatado e travessão em diagonal.
  { x: 80, largura: 86, d: 'M0 100 L34 0 H52 L86 100 H62 L56 82 H30 L24 100 Z M37 62 H49 L43 44 Z' },
  // Y — braços em diagonal e haste reta.
  { x: 174, largura: 80, d: 'M0 0 H24 L40 34 L56 0 H80 L52 54 V100 H28 V54 Z' },
  // A e X formam o bloco em degradê, encostados como no logotipo.
  { x: 262, largura: 86, gradiente: true, d: 'M0 100 L34 0 H52 L86 100 H62 L56 82 H30 L24 100 Z M37 62 H49 L43 44 Z' },
  { x: 352, largura: 84, gradiente: true, d: 'M0 0 H26 L42 30 L58 0 H84 L55 50 L84 100 H58 L42 70 L26 100 H0 L29 50 Z' },
];
const LARGURA = 436;

const criar = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  return e;
};

/**
 * Letreiro PAYAX.
 * @param {{altura?: number, cor?: string, degrade?: [string, string], tagline?: boolean, classe?: string}} o
 *   `cor` pinta PAY; `degrade` pinta AX (dois tons). Com `tagline`, inclui "O FUTURO EM CADA TRANSAÇÃO.".
 */
export function letreiro({ altura = 28, cor = '#ffffff', degrade = ['#8fe3fb', '#2e8ee6'], tagline = false, classe = '' } = {}) {
  sequencia += 1;
  const id = `payax-degrade-${sequencia}`;
  const alturaCaixa = tagline ? 148 : 100;
  const svg = criar('svg', {
    viewBox: `0 0 ${LARGURA} ${alturaCaixa}`,
    height: altura,
    width: (LARGURA / alturaCaixa) * altura,
    fill: 'none',
    role: 'img',
    'aria-label': 'PAY AX',
    class: classe || null,
  });

  const defs = criar('defs');
  const g = criar('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
  g.append(criar('stop', { offset: '0', 'stop-color': degrade[0] }), criar('stop', { offset: '1', 'stop-color': degrade[1] }));
  defs.append(g);
  svg.append(defs);

  for (const l of LETRAS) {
    const p = criar('path', { d: l.d, fill: l.gradiente ? `url(#${id})` : cor, 'fill-rule': 'evenodd', transform: `translate(${l.x} 0)` });
    svg.append(p);
  }

  if (tagline) {
    // A frase ocupa a mesma largura do letreiro: corpo pequeno com muito espaçamento, como no original.
    const t = criar('text', {
      x: LARGURA / 2, y: 136, 'text-anchor': 'middle', fill: cor, 'font-size': '14',
      'letter-spacing': '7.1', 'font-family': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      'font-weight': '300', opacity: '0.8',
      // O espaçamento sobra depois da última letra; metade dele volta para o centro ficar certo.
      transform: 'translate(3.5 0)',
    });
    t.textContent = 'O FUTURO EM CADA TRANSAÇÃO.';
    svg.append(t);
  }
  return svg;
}

/**
 * Símbolo: o anel luminoso com as faixas diagonais atravessando — o que sobra do logotipo
 * quando não há espaço para o letreiro (favicon, avatar, canto do cartão).
 */
export function simbolo({ tamanho = 32, cor = '#4fb8f5', degrade = null, fundo = null, faixas = null, classe = '' } = {}) {
  const [claro, escuro] = degrade ?? ['#9fe4fc', cor];
  // As faixas só aparecem na versão com fundo (favicon, avatar). Soltas sobre branco elas
  // viram duas manchas cinzentas e roubam a figura do anel, que é o que se reconhece.
  const comFaixas = faixas ?? Boolean(fundo);
  sequencia += 1;
  const id = `payax-anel-${sequencia}`;
  const svg = criar('svg', { viewBox: '0 0 48 48', width: tamanho, height: tamanho, fill: 'none', 'aria-hidden': 'true', class: classe || null });
  const defs = criar('defs');
  const g = criar('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
  g.append(criar('stop', { offset: '0', 'stop-color': claro }), criar('stop', { offset: '1', 'stop-color': escuro }));
  defs.append(g);
  svg.append(defs);
  if (fundo) svg.append(criar('rect', { width: 48, height: 48, rx: 11, fill: fundo }));
  if (comFaixas) {
    svg.append(criar('path', { d: 'M33 1 L45 1 L21 47 L9 47 Z', fill: cor, opacity: '0.13' }));
    svg.append(criar('path', { d: 'M42 9 L48 9 L31 47 L25 47 Z', fill: cor, opacity: '0.09' }));
  }
  // O anel luminoso, a parte reconhecível da marca.
  svg.append(criar('circle', { cx: 24, cy: 24, r: 16, stroke: `url(#${id})`, 'stroke-width': '2.6' }));
  return svg;
}

/** Versão em texto do símbolo e do letreiro, para quando só cabe string (favicon .svg, e-mail). */
export const faviconSvg = (cor = '#4fb8f5', fundo = '#081426') => `<svg xmlns="${SVG}" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="11" fill="${fundo}"/>
  <path d="M33 1 L45 1 L21 47 L9 47 Z" fill="${cor}" opacity=".13"/>
  <path d="M42 9 L48 9 L31 47 L25 47 Z" fill="${cor}" opacity=".09"/>
  <circle cx="24" cy="24" r="16" fill="none" stroke="${cor}" stroke-width="2.6"/>
</svg>`;

/**
 * Marca do menu lateral: anel, letreiro e a linha do produto embaixo.
 * Devolve os dois nós já prontos para entrar num `.marca`.
 */
export function marcaMenu(produto) {
  const caixa = document.createElement('span');
  caixa.className = 'marca-texto';
  caixa.append(letreiro({ altura: 19 }));
  const linha = document.createElement('small');
  linha.textContent = produto;
  caixa.append(linha);
  return [simbolo({ tamanho: 30, classe: 'marca-simbolo' }), caixa];
}

/** Marca da tela de entrada: fundo claro, por isso o letreiro vem em marinho. */
export function marcaEntrada(produto) {
  const caixa = document.createElement('div');
  caixa.className = 'marca-entrada';
  caixa.append(
    simbolo({ tamanho: 38, cor: '#0b4a96', degrade: ['#3ea8f5', '#0b4a96'] }),
    letreiro({ altura: 24, cor: '#0a1526', degrade: ['#2b9fe8', '#0f5fbf'] }),
  );
  const linha = document.createElement('small');
  linha.textContent = produto;
  caixa.append(linha);
  return caixa;
}
