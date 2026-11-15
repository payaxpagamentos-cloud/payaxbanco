/*
 * Marca PAY AX, desenhada em vetor para funcionar em qualquer tamanho e sobre qualquer fundo.
 *
 * O logotipo é o letreiro PAYAX (PAY sólido, AX em fitas com degradê). Onde não cabe o letreiro
 * inteiro (ícone da aba do navegador), entra o "AX" dele, sozinho.
 *
 * As letras foram vetorizadas a partir do logotipo oficial. Se o arquivo vetorial do designer
 * (.svg/.ai) estiver disponível, trocar PAY, AX e SOMBRA aqui coloca o desenho dele no lugar —
 * nada mais no sistema muda.
 */
const SVG = 'http://www.w3.org/2000/svg';
let sequencia = 0;

/**
 * Letreiro vetorizado a partir do logotipo oficial (altura das maiúsculas = 100). PAY é uma forma só;
 * AX é a forma das fitas, pintada em degradê, e a SOMBRA é o trecho onde as fitas do X se cruzam.
 */
const PAY = 'M92.4 99.5 L92.4 100.0 L122.1 100.0 L133.6 81.2 L165.5 26.0 L166.6 25.8 L185.5 59.5 L185.8 60.8 L156.9 61.1 L146.8 77.5 L145.4 80.2 L144.8 80.9 L144.8 81.6 L197.0 81.8 L197.5 82.1 L205.9 97.8 L207.4 100.0 L238.2 100.0 L226.4 78.7 L223.6 74.5 L181.4 0.2 L153.4 0.2 L152.9 0.7 L138.7 24.3 Z M199.2 0.2 L199.2 0.7 L248.0 62.0 L248.3 100.0 L275.2 99.8 L275.3 62.7 L275.7 61.8 L326.2 0.7 L326.2 0.2 L295.9 0.3 L263.0 41.2 L262.2 41.2 L241.0 13.2 L230.7 0.2 Z M0.0 99.7 L0.2 100.0 L26.9 99.8 L26.9 66.0 L27.4 65.5 L85.6 65.5 L91.9 64.9 L96.8 63.5 L101.7 61.3 L106.1 58.3 L110.0 53.9 L112.7 49.3 L114.7 43.4 L116.0 35.3 L115.9 26.7 L114.7 20.6 L113.3 16.7 L112.0 14.0 L109.0 9.8 L105.1 6.1 L100.3 3.2 L95.3 1.4 L89.4 0.3 L0.2 0.0 Z M26.9 21.3 L27.5 20.4 L79.6 20.4 L82.6 20.9 L84.6 21.6 L87.2 23.1 L88.7 24.7 L89.9 26.7 L90.5 28.5 L91.0 31.6 L90.5 37.2 L89.0 40.5 L86.8 42.9 L85.1 44.1 L83.4 44.8 L80.1 45.4 L27.4 45.4 L26.9 44.9 Z';
const AX = 'M584.3 -0.2 L547.8 -0.2 L520.4 24.7 L520.3 25.5 L537.3 43.6 L538.2 43.6 L584.3 0.3 Z M308.3 100.7 L308.4 101.4 L348.1 101.4 L348.6 101.0 L395.6 30.6 L396.6 30.4 L407.6 49.2 L414.9 60.8 L414.9 61.5 L413.3 61.8 L386.5 61.8 L372.3 81.2 L372.0 82.4 L427.4 82.4 L428.4 83.4 L429.9 86.5 L439.0 101.2 L478.4 101.4 L508.4 72.5 L509.3 72.5 L531.9 97.5 L535.8 101.4 L577.0 101.4 L577.0 100.8 L529.1 47.8 L487.3 2.7 L484.3 -0.2 L442.9 0.0 L443.2 0.8 L456.9 15.2 L488.3 49.5 L488.2 50.7 L480.7 57.1 L462.7 74.0 L461.7 73.8 L458.1 67.7 L444.6 47.0 L416.7 2.7 L414.5 -0.2 L379.7 -0.2 L376.5 3.7 L334.6 63.7 L330.7 68.8 L312.8 94.6 Z';
const SOMBRA = 'M489.5 50.7 L487.7 50.8 L463.0 73.5 L463.3 76.0 L478.2 100.3 L480.4 99.7 L508.3 72.8 L507.6 70.4 Z';
const AX_INICIO = 308.3;
const LARGURA = 584.3;

const criar = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  return e;
};

/**
 * Letreiro PAYAX.
 * @param {{altura?: number, cor?: string, degrade?: [string, string], tagline?: boolean, classe?: string}} o
 *   `cor` pinta PAY; `degrade` pinta AX ([claro, escuro]); `sombra` é o cruzamento das fitas do X.
 *   Com `tagline`, inclui "O FUTURO EM CADA TRANSAÇÃO.".
 */
export function letreiro({ altura = 28, cor = '#ffffff', degrade = ['#00f0fd', '#1784ee'], sombra = '#0b62cf', tagline = false, classe = '' } = {}) {
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
  // Como no logotipo: escuro embaixo à esquerda, ciano no alto à direita.
  const g = criar('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: AX_INICIO, y1: 100, x2: AX_INICIO + 150, y2: 0 });
  g.append(criar('stop', { offset: '0', 'stop-color': degrade[1] }), criar('stop', { offset: '0.6', 'stop-color': degrade[0] }),
    criar('stop', { offset: '1', 'stop-color': degrade[0] }));
  defs.append(g);
  svg.append(defs);

  svg.append(criar('path', { d: PAY, fill: cor, 'fill-rule': 'evenodd' }));
  svg.append(criar('path', { d: AX, fill: `url(#${id})`, 'fill-rule': 'evenodd' }));
  svg.append(criar('path', { d: SOMBRA, fill: sombra }));

  if (tagline) {
    // A frase ocupa a mesma largura do letreiro: corpo pequeno com muito espaçamento, como no original.
    const t = criar('text', {
      x: LARGURA / 2, y: 138, 'text-anchor': 'middle', fill: cor, 'font-size': '19',
      'letter-spacing': '9.4', 'font-family': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      'font-weight': '300', opacity: '0.8',
      // O espaçamento sobra depois da última letra; metade dele volta para o centro ficar certo.
      transform: 'translate(4.7 0)',
    });
    t.textContent = 'O FUTURO EM CADA TRANSAÇÃO.';
    svg.append(t);
  }
  return svg;
}

/**
 * Símbolo: o "AX" do próprio logotipo (fitas em degradê), para onde não cabe o letreiro inteiro —
 * ícone da aba do navegador, avatar. Com `fundo`, vem num quadrado arredondado.
 */
const AX_LARGURA = LARGURA - AX_INICIO;
function caixaAx(fundo) {
  const lado = AX_LARGURA + 90;
  return { x: AX_INICIO - 45, y: 50 - lado / 2, lado };
}
export function simbolo({ tamanho = 32, degrade = ['#00f0fd', '#1784ee'], sombra = '#0b62cf', fundo = null, classe = '' } = {}) {
  sequencia += 1;
  const id = `payax-ax-${sequencia}`;
  const c = caixaAx(fundo);
  const svg = criar('svg', { viewBox: `${c.x} ${c.y} ${c.lado} ${c.lado}`, width: tamanho, height: tamanho, fill: 'none', 'aria-hidden': 'true', class: classe || null });
  const defs = criar('defs');
  const g = criar('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: AX_INICIO, y1: 100, x2: AX_INICIO + 150, y2: 0 });
  g.append(criar('stop', { offset: '0', 'stop-color': degrade[1] }), criar('stop', { offset: '0.6', 'stop-color': degrade[0] }),
    criar('stop', { offset: '1', 'stop-color': degrade[0] }));
  defs.append(g);
  svg.append(defs);
  if (fundo) svg.append(criar('rect', { x: c.x, y: c.y, width: c.lado, height: c.lado, rx: c.lado * 0.22, fill: fundo }));
  svg.append(criar('path', { d: AX, fill: `url(#${id})`, 'fill-rule': 'evenodd' }), criar('path', { d: SOMBRA, fill: sombra }));
  return svg;
}

/** Versão em texto do símbolo (ícone da aba do navegador). */
export const faviconSvg = (fundo = '#081426') => {
  const c = caixaAx(fundo);
  return `<svg xmlns="${SVG}" viewBox="${c.x} ${c.y} ${c.lado} ${c.lado}">
  <defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${AX_INICIO}" y1="100" x2="${AX_INICIO + 150}" y2="0">
    <stop offset="0" stop-color="#1784ee"/><stop offset=".6" stop-color="#00f0fd"/><stop offset="1" stop-color="#00f0fd"/></linearGradient></defs>
  <rect x="${c.x}" y="${c.y}" width="${c.lado}" height="${c.lado}" rx="${c.lado * 0.22}" fill="${fundo}"/>
  <path d="${AX}" fill="url(#g)" fill-rule="evenodd"/><path d="${SOMBRA}" fill="#0b62cf"/>
</svg>`;
};

/**
 * Marca do menu lateral: o logotipo e a linha do produto embaixo.
 * Devolve os dois nós já prontos para entrar num `.marca`.
 */
export function marcaMenu(produto) {
  const caixa = document.createElement('span');
  caixa.className = 'marca-texto';
  // Só o logotipo, como ele é: nada de símbolo ao lado.
  caixa.append(letreiro({ altura: 23 }));
  const linha = document.createElement('small');
  linha.textContent = produto;
  caixa.append(linha);
  return [caixa];
}

/** Marca da tela de entrada: fundo claro, por isso o letreiro vem em marinho. */
export function marcaEntrada(produto) {
  const caixa = document.createElement('div');
  caixa.className = 'marca-entrada';
  caixa.append(
    letreiro({ altura: 34, cor: '#0a1526', degrade: ['#00c3ef', '#1265d6'], sombra: '#0a4fb0' }),
  );
  const linha = document.createElement('small');
  linha.textContent = produto;
  caixa.append(linha);
  return caixa;
}
