/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/**
 * Cena da tela de entrada: uma cidade à noite em 3D (perspectiva), girando devagar, com prédios, avenidas iluminadas e veículos
 * andando pelas ruas com rastro de luz. De tempos em tempos um veículo é "localizado": pulso de radar no chão e a placa por cima.
 * Desenhada em canvas 2D, sem bibliotecas. Com "reduzir movimento" ligado no sistema, mostra um quadro parado.
 * Devolve a função que para a animação.
 */
const TAM = 9; // a cidade vai de -TAM a +TAM quadras
const AVENIDA = 3; // uma avenida a cada 3 ruas
const CORES = ['#36E0C0', '#6C9DFF', '#5CDDD5', '#8B7BFF', '#F5C46B'];
const LETRAS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

// Gerador fixo: a cidade é sempre a mesma.
let semente = 7;
const aleatorio = () => ((semente = (semente * 16807) % 2147483647) / 2147483647);

function montarCidade() {
  semente = 7;
  const predios = [];
  for (let i = -TAM; i < TAM; i++) {
    for (let j = -TAM; j < TAM; j++) {
      if (aleatorio() < 0.34) continue; // praças e terrenos
      const centro = Math.hypot(i + 0.5, j + 0.5);
      // Torres no centro, prédios baixos nas bordas.
      const torre = centro < TAM * 0.45 && aleatorio() < 0.3 ? 1.8 + aleatorio() * 1.6 : 0;
      const alto = torre || Math.max(0.12, (1.3 - centro / TAM) * (0.25 + aleatorio() * 0.8));
      const m = 0.16 + aleatorio() * 0.08;
      predios.push({ x0: i + m, x1: i + 1 - m, z0: j + m, z1: j + 1 - m, h: alto, tom: 0.75 + aleatorio() * 0.5 });
    }
  }
  return predios;
}

const placa = () => `${Array.from({ length: 3 }, () => LETRAS[Math.floor(aleatorio() * LETRAS.length)]).join('')}${Math.floor(aleatorio() * 10)}${LETRAS[Math.floor(aleatorio() * LETRAS.length)]}${String(Math.floor(aleatorio() * 100)).padStart(2, '0')}`;

/** Veículo andando pelas ruas (linhas inteiras do grid): segue reto e, nos cruzamentos, às vezes vira. */
function novoVeiculo(i) {
  const horizontal = aleatorio() < 0.5;
  const linha = Math.round((aleatorio() * 2 - 1) * (TAM - 1));
  const pos = (aleatorio() * 2 - 1) * TAM;
  return {
    x: horizontal ? pos : linha, z: horizontal ? linha : pos, dx: horizontal ? (aleatorio() < 0.5 ? 1 : -1) : 0, dz: horizontal ? 0 : (aleatorio() < 0.5 ? 1 : -1),
    vel: 0.9 + aleatorio() * 1.1, cor: CORES[i % CORES.length], rastro: [], placa: placa(), kmh: 28 + Math.floor(aleatorio() * 50),
  };
}

function andar(v, dt) {
  const antes = { x: v.x, z: v.z };
  v.x += v.dx * v.vel * dt;
  v.z += v.dz * v.vel * dt;
  // Cruzou um cruzamento: alinha na rua e decide se vira.
  const cruzou = (a, b) => Math.floor(a) !== Math.floor(b);
  if ((v.dx && cruzou(antes.x, v.x)) || (v.dz && cruzou(antes.z, v.z))) {
    const cx = v.dx ? Math.round(v.dx > 0 ? Math.floor(v.x) : Math.ceil(v.x)) : v.x;
    const cz = v.dz ? Math.round(v.dz > 0 ? Math.floor(v.z) : Math.ceil(v.z)) : v.z;
    if (aleatorio() < 0.3) {
      v.x = cx; v.z = cz;
      const s = aleatorio() < 0.5 ? 1 : -1;
      [v.dx, v.dz] = v.dx ? [0, s] : [s, 0];
    }
  }
  // Saiu da cidade: volta pela borda oposta.
  if (Math.abs(v.x) > TAM) { v.x = -Math.sign(v.x) * TAM; v.rastro = []; }
  if (Math.abs(v.z) > TAM) { v.z = -Math.sign(v.z) * TAM; v.rastro = []; }
  v.rastro.push({ x: v.x, z: v.z });
  if (v.rastro.length > 40) v.rastro.shift();
}

export function iniciarCena(canvas) {
  const ctx = canvas.getContext('2d');
  const predios = montarCidade();
  const veiculos = Array.from({ length: 26 }, (_, i) => novoVeiculo(i));
  const parado = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let largura = 0;
  let altura = 0;
  let angulo = 0.6;
  let alvo = 0;
  let tempoAlvo = 0;
  let quadro = 0;
  let ultimo = performance.now();
  let iniciada = false;

  function ajustar() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    largura = canvas.clientWidth;
    altura = canvas.clientHeight;
    canvas.width = Math.round(largura * dpr);
    canvas.height = Math.round(altura * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (parado && iniciada) desenharQuadro(0);
  }
  const obs = new ResizeObserver(ajustar);
  obs.observe(canvas);
  ajustar();

  /** Projeção: gira a cidade em torno do centro, inclina a câmera e aplica a perspectiva. */
  function projetar(x, y, z) {
    const c = Math.cos(angulo);
    const s = Math.sin(angulo);
    const xr = x * c - z * s;
    const zr = x * s + z * c;
    const inc = 1.02;
    const prof = 26 + zr * Math.cos(inc) - y * Math.sin(inc);
    // No computador a cidade ocupa a largura; no celular (tela em pé), a altura.
    const f = largura > altura ? Math.min(largura, altura * 1.6) * 1.15 : Math.max(largura * 1.5, altura * 0.95);
    return { x: largura * 0.5 + (f * xr) / prof, y: altura * 0.56 - (f * (zr * Math.sin(inc) + y * Math.cos(inc))) / prof, prof };
  }

  function linha(a, b, cor, largura2) {
    const p = projetar(a[0], 0, a[1]);
    const q = projetar(b[0], 0, b[1]);
    ctx.strokeStyle = cor;
    ctx.lineWidth = largura2;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  function predio(b, prof) {
    // Névoa: o que está longe fica mais apagado (dá profundidade).
    ctx.globalAlpha = Math.max(0.25, Math.min(1, 1.35 - (prof - 18) / 18));
    const cantos = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
    const base = cantos.map(([x, z]) => projetar(x, 0, z));
    const topo = cantos.map(([x, z]) => projetar(x, b.h, z));
    // Faces laterais (as de trás ficam cobertas pela frente, desenhadas depois por profundidade).
    const faces = [0, 1, 2, 3].map((k) => ({ k, prof: (base[k].prof + base[(k + 1) % 4].prof) / 2 })).sort((a, b2) => b2.prof - a.prof);
    for (const { k } of faces) {
      const n = (k + 1) % 4;
      const luz = 0.10 + 0.05 * ((k + Math.round(angulo * 2)) % 2);
      ctx.fillStyle = `rgba(${Math.round(40 * b.tom)}, ${Math.round(70 * b.tom)}, ${Math.round(120 * b.tom)}, ${0.55 + luz})`;
      ctx.beginPath(); ctx.moveTo(base[k].x, base[k].y); ctx.lineTo(base[n].x, base[n].y); ctx.lineTo(topo[n].x, topo[n].y); ctx.lineTo(topo[k].x, topo[k].y); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = `rgba(${Math.round(70 * b.tom)}, ${Math.round(110 * b.tom)}, ${Math.round(170 * b.tom)}, 0.85)`;
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); topo.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function veiculo(v, destaque) {
    const p = projetar(v.x, 0.02, v.z);
    // Rastro de luz.
    if (v.rastro.length > 1) {
      for (let i = 1; i < v.rastro.length; i++) {
        const a = projetar(v.rastro[i - 1].x, 0.02, v.rastro[i - 1].z);
        const b = projetar(v.rastro[i].x, 0.02, v.rastro[i].z);
        if (Math.hypot(a.x - b.x, a.y - b.y) > 60) continue;
        ctx.strokeStyle = v.cor;
        ctx.globalAlpha = (i / v.rastro.length) * 0.85;
        ctx.lineWidth = 3.2;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    const r = Math.max(3, 120 / p.prof);
    const brilho = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
    brilho.addColorStop(0, `${v.cor}AA`);
    brilho.addColorStop(1, `${v.cor}00`);
    ctx.fillStyle = brilho;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = v.cor;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.55, 0, Math.PI * 2); ctx.fill();
    if (destaque) localizado(v, p);
  }

  /** Veículo localizado: pulsos de radar no chão, pino e a placa com a velocidade. */
  function localizado(v, p) {
    const t = (quadro % 90) / 90;
    for (const fase of [0, 0.5]) {
      const k = (t + fase) % 1;
      ctx.strokeStyle = `rgba(54, 224, 192, ${0.8 * (1 - k)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let a = 0; a <= 32; a++) {
        const ang = (a / 32) * Math.PI * 2;
        const q = projetar(v.x + Math.cos(ang) * k * 1.6, 0.02, v.z + Math.sin(ang) * k * 1.6);
        if (a) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();
    }
    const topo = projetar(v.x, 1.6, v.z);
    ctx.strokeStyle = 'rgba(54, 224, 192, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(topo.x, topo.y); ctx.stroke();
    ctx.setLineDash([]);
    const texto = `${v.placa} · ${v.kmh} km/h`;
    ctx.font = '600 12px Manrope, system-ui, sans-serif';
    const w = ctx.measureText(texto).width + 34;
    const x = topo.x - w / 2;
    const y = topo.y - 30;
    ctx.fillStyle = 'rgba(8, 15, 30, 0.85)';
    ctx.strokeStyle = 'rgba(54, 224, 192, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, 26, 13); ctx.fill(); ctx.stroke();
    ctx.fillStyle = v.cor;
    ctx.beginPath(); ctx.arc(x + 14, y + 13, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#E2E8F0';
    ctx.fillText(texto, x + 24, y + 17.5);
  }

  function desenharQuadro(dt) {
    quadro++;
    angulo += dt * 0.045;
    for (const v of veiculos) andar(v, dt);
    tempoAlvo += dt;
    if (tempoAlvo > 4.5) { tempoAlvo = 0; alvo = (alvo + 7) % veiculos.length; }

    ctx.clearRect(0, 0, largura, altura);
    // Ruas e avenidas (as avenidas brilham).
    for (let k = -TAM; k <= TAM; k++) {
      const av = k % AVENIDA === 0;
      const cor = av ? 'rgba(56, 189, 248, 0.42)' : 'rgba(96, 125, 170, 0.22)';
      linha([k, -TAM], [k, TAM], cor, av ? 1.6 : 0.8);
      linha([-TAM, k], [TAM, k], cor, av ? 1.6 : 0.8);
    }
    // Prédios e veículos na ordem de profundidade (os de trás primeiro).
    const itens = [
      ...predios.map((b) => ({ tipo: 'p', b, prof: projetar((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2).prof })),
      ...veiculos.map((v, i) => ({ tipo: 'v', v, i, prof: projetar(v.x, 0, v.z).prof - 0.6 })),
    ].sort((a, b) => b.prof - a.prof);
    for (const it of itens) {
      if (it.tipo === 'p') predio(it.b, it.prof);
      else veiculo(it.v, it.i === alvo);
    }
  }

  let id = 0;
  function ciclo(agora) {
    const dt = Math.min(0.05, (agora - ultimo) / 1000);
    ultimo = agora;
    desenharQuadro(dt);
    id = requestAnimationFrame(ciclo);
  }
  iniciada = true;
  if (parado) {
    for (let i = 0; i < 60; i++) for (const v of veiculos) andar(v, 0.05);
    desenharQuadro(0);
  } else {
    id = requestAnimationFrame(ciclo);
  }
  return () => { cancelAnimationFrame(id); obs.disconnect(); };
}
