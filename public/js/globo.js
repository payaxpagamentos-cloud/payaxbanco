/**
 * Globo 3D de pontos com órbitas e nós luminosos, desenhado em canvas 2D (sem bibliotecas).
 * Para sozinho quando o canvas sai da página; sem animação para quem prefere movimento reduzido.
 */
export function globo(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const parado = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const N = 900;
  // Pontos distribuídos por igual na esfera (espiral de Fibonacci).
  const pontos = Array.from({ length: N }, (_, i) => {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = i * Math.PI * (3 - Math.sqrt(5));
    return [Math.cos(t) * r, y, Math.sin(t) * r];
  });
  // Órbitas inclinadas, cada uma com alguns nós que correm por ela.
  const orbitas = [
    { inc: 0.35, giro: 0.2, raio: 1.18, nos: 3, vel: 0.35 },
    { inc: -0.9, giro: 1.1, raio: 1.08, nos: 2, vel: -0.25 },
    { inc: 1.25, giro: -0.6, raio: 1.28, nos: 3, vel: 0.18 },
  ];
  let largura = 0, altura = 0, dpr = 1;
  const medir = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const caixa = canvas.getBoundingClientRect();
    largura = caixa.width; altura = caixa.height;
    canvas.width = Math.round(largura * dpr); canvas.height = Math.round(altura * dpr);
  };
  medir();
  window.addEventListener('resize', medir);

  const girar = ([x, y, z], ay, ax) => {
    const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    return [x1, y * cx - z1 * sx, y * sx + z1 * cx];
  };

  const desenhar = (tempo) => {
    if (!canvas.isConnected) { window.removeEventListener('resize', medir); return; }
    const t = parado ? 0 : tempo / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, largura, altura);
    const R = Math.min(largura, altura) * 0.38;
    const cx = largura / 2, cy = altura / 2;
    const ay = t * 0.12, ax = -0.35;

    // Halo atrás do globo
    const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.5);
    halo.addColorStop(0, 'rgba(34,197,139,0.30)');
    halo.addColorStop(0.55, 'rgba(30,110,180,0.10)');
    halo.addColorStop(1, 'rgba(11,31,58,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.5, 0, Math.PI * 2); ctx.fill();

    // Pontos da esfera: os da frente maiores e mais claros
    for (const p of pontos) {
      const [x, y, z] = girar(p, ay, ax);
      const prof = (z + 1) / 2;
      ctx.fillStyle = `rgba(${Math.round(140 + 90 * prof)},${Math.round(210 + 45 * prof)},${Math.round(230 + 25 * prof)},${0.22 + 0.78 * prof * prof})`;
      const s = 0.9 + 1.7 * prof;
      ctx.fillRect(cx + x * R - s / 2, cy + y * R - s / 2, s, s);
    }

    // Órbitas e nós luminosos
    for (const o of orbitas) {
      ctx.beginPath();
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        const [x, y] = girar(girar([Math.cos(a) * o.raio, 0, Math.sin(a) * o.raio], o.giro, o.inc), ay * 0.5, ax);
        if (k) ctx.lineTo(cx + x * R, cy + y * R); else ctx.moveTo(cx + x * R, cy + y * R);
      }
      ctx.strokeStyle = 'rgba(60,215,170,0.42)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      for (let n = 0; n < o.nos; n++) {
        const a = t * o.vel + (n / o.nos) * Math.PI * 2;
        const [x, y, z] = girar(girar([Math.cos(a) * o.raio, 0, Math.sin(a) * o.raio], o.giro, o.inc), ay * 0.5, ax);
        const px = cx + x * R, py = cy + y * R, f = (z + 1.3) / 2.3;
        const brilho = ctx.createRadialGradient(px, py, 0, px, py, 14 * f);
        brilho.addColorStop(0, `rgba(95,220,174,${0.9 * f})`);
        brilho.addColorStop(1, 'rgba(34,197,139,0)');
        ctx.fillStyle = brilho;
        ctx.beginPath(); ctx.arc(px, py, 14 * f, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(220,255,240,${f})`;
        ctx.beginPath(); ctx.arc(px, py, 2.4 * f, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (!parado) requestAnimationFrame(desenhar);
  };
  requestAnimationFrame(desenhar);
}
