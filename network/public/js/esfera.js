/*
 * Esfera de conectividade da tela de entrada. Canvas 2D puro, sem nenhuma biblioteca.
 *
 * É decoração: não mostra dado nenhum do provedor, e por isso fica fora do fluxo de leitura
 * (aria-hidden no elemento que a contém). O desenho é caro, então ela se comporta:
 *   - no máximo ~30 quadros por segundo;
 *   - para de desenhar quando sai da área visível ou a aba vai para segundo plano;
 *   - respeita "prefers-reduced-motion": desenha uma vez, parada;
 *   - devolve uma função que remove TODOS os observadores e cancela o quadro pendente.
 *
 * Veio do pacote de design aprovado; os comentários foram passados para o idioma do repositório.
 */
export function criarEsfera(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return () => {};

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, height = 0, frame = 0, previous = 0, visible = true, disposed = false;
  let angle = 0.22;
  const nodes = Array.from({ length: 19 }, (_, i) => {
    const y = 1 - 2 * (i + 0.5) / 19;
    const a = i * 2.399963229728653;
    const r = Math.sqrt(1 - y * y);
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
  });
  const routes = [[0, 3], [0, 8], [2, 6], [3, 9], [4, 11], [6, 14], [8, 13], [9, 16], [11, 17], [13, 18]];

  function project(point, radius, rotation = angle) {
    const x = point.x * Math.cos(rotation) - point.z * Math.sin(rotation);
    const z = point.x * Math.sin(rotation) + point.z * Math.cos(rotation);
    const tilt = -0.17;
    const y = point.y * Math.cos(tilt) - z * Math.sin(tilt);
    const depth = point.y * Math.sin(tilt) + z * Math.cos(tilt);
    return { x: width * 0.5 + x * radius, y: height * 0.48 + y * radius, z: depth };
  }

  function curve(points, radius, front, color, lineWidth = 0.7, rotation = angle) {
    ctx.beginPath();
    let drawing = false;
    for (const point of points) {
      const p = project(point, radius, rotation);
      if ((p.z >= 0) !== front) { drawing = false; continue; }
      if (drawing) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      drawing = true;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  const meridians = Array.from({ length: 9 }, (_, i) => {
    const longitude = i * Math.PI / 9;
    return Array.from({ length: 97 }, (_, j) => {
      const t = j * Math.PI * 2 / 96;
      return { x: Math.cos(t) * Math.cos(longitude), y: Math.sin(t), z: Math.cos(t) * Math.sin(longitude) };
    });
  });
  const parallels = [-0.65, -0.32, 0, 0.32, 0.65].map(y =>
    Array.from({ length: 97 }, (_, j) => {
      const t = j * Math.PI * 2 / 96, r = Math.sqrt(1 - y * y);
      return { x: Math.cos(t) * r, y, z: Math.sin(t) * r };
    })
  );
  const orbits = [-0.48, 0.72].map((tilt, i) =>
    Array.from({ length: 161 }, (_, j) => {
      const t = j * Math.PI * 2 / 160;
      const x = Math.cos(t) * 1.2, y = Math.sin(t) * Math.sin(tilt) * 1.2;
      return { x, y, z: Math.sin(t) * Math.cos(tilt) * (i ? 0.94 : 1.2) };
    })
  );
  const arcs = routes.map(([a, b]) => {
    const u = nodes[a], v = nodes[b];
    const omega = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y + u.z * v.z)));
    const sin = Math.sin(omega);
    return Array.from({ length: 40 }, (_, j) => {
      const t = j / 39;
      const first = Math.sin((1 - t) * omega) / sin, second = Math.sin(t * omega) / sin;
      return { x: first * u.x + second * v.x, y: first * u.y + second * v.y, z: first * u.z + second * v.z };
    });
  });

  function paint(time = 0) {
    if (!width || !height || disposed) return;
    if (!reduced.matches) angle = 0.22 + time * 0.000045;
    const radius = Math.min(width, height) * 0.315;
    const cx = width * 0.5, cy = height * 0.48;
    ctx.clearRect(0, 0, width, height);

    const halo = ctx.createRadialGradient(cx, cy, radius * 0.35, cx, cy, radius * 1.6);
    halo.addColorStop(0, 'rgba(25,212,135,.10)');
    halo.addColorStop(0.7, 'rgba(23,175,114,.045)');
    halo.addColorStop(1, 'rgba(0,90,57,0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, width, height);

    ctx.save(); ctx.translate(cx, cy + radius * 1.07); ctx.scale(1, 0.13);
    const ground = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 1.1);
    ground.addColorStop(0, 'rgba(79,241,162,.43)');
    ground.addColorStop(0.35, 'rgba(39,217,141,.14)');
    ground.addColorStop(1, 'rgba(0,98,58,0)');
    ctx.fillStyle = ground; ctx.beginPath(); ctx.arc(0, 0, radius * 1.1, 0, Math.PI * 2); ctx.fill(); ctx.restore();

    orbits.forEach(points => curve(points, radius, false, 'rgba(89,239,175,.18)', 1.1, angle * 0.22));
    const glass = ctx.createRadialGradient(cx - radius * 0.5, cy - radius * 0.6, 0, cx, cy, radius * 1.2);
    glass.addColorStop(0, 'rgba(166,255,216,.25)');
    glass.addColorStop(0.22, 'rgba(69,190,141,.09)');
    glass.addColorStop(0.62, 'rgba(0,27,19,.30)');
    glass.addColorStop(0.84, 'rgba(26,125,87,.15)');
    glass.addColorStop(1, 'rgba(196,255,231,.41)');
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fillStyle = glass; ctx.fill();

    for (const front of [false, true]) {
      for (const points of [...meridians, ...parallels]) curve(points, radius, front, front ? 'rgba(101,232,175,.15)' : 'rgba(112,241,190,.045)');
      for (const points of arcs) curve(points, radius * 1.003, front, front ? 'rgba(102,248,180,.53)' : 'rgba(90,211,160,.06)', 0.85);
    }
    const rim = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    rim.addColorStop(0, 'rgba(210,255,237,.86)');
    rim.addColorStop(0.35, 'rgba(115,238,184,.18)');
    rim.addColorStop(0.75, 'rgba(90,215,168,.12)');
    rim.addColorStop(1, 'rgba(181,255,218,.84)');
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.strokeStyle = rim; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx - radius * 0.07, cy, radius * 0.85, radius * 1.01, -0.36, Math.PI * 0.97, Math.PI * 1.73);
    ctx.strokeStyle = 'rgba(210,255,234,.27)'; ctx.lineWidth = 1; ctx.stroke();

    for (const points of orbits) {
      ctx.save(); ctx.shadowBlur = 13; ctx.shadowColor = '#66ffad';
      curve(points, radius, true, 'rgba(81,232,149,.76)', 1.9, angle * 0.22);
      curve(points, radius, true, 'rgba(212,255,224,.84)', 0.65, angle * 0.22); ctx.restore();
    }
    for (const node of nodes) {
      const p = project(node, radius * 1.005);
      if (p.z < 0) continue;
      const size = 1.4 + p.z * 2.1;
      ctx.save(); ctx.shadowBlur = 12; ctx.shadowColor = '#7bffbf';
      ctx.fillStyle = '#cdffe5'; ctx.beginPath(); ctx.arc(p.x, p.y, size, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  }

  function tick(time) {
    frame = 0;
    if (disposed || !visible || document.hidden || reduced.matches || width < 1 || height < 1) return;
    if (time - previous >= 1000 / 30) { paint(time); previous = time; }
    frame = window.requestAnimationFrame(tick);
  }
  function refresh() {
    window.cancelAnimationFrame(frame); frame = 0;
    if (disposed) return;
    paint(previous);
    if (visible && !document.hidden && !reduced.matches && width > 0 && height > 0) frame = window.requestAnimationFrame(tick);
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width; height = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    refresh();
  }
  const observer = new ResizeObserver(resize);
  const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; refresh(); });
  observer.observe(canvas); intersection.observe(canvas);
  document.addEventListener('visibilitychange', refresh);
  reduced.addEventListener('change', refresh);
  resize();
  return () => {
    disposed = true; window.cancelAnimationFrame(frame);
    observer.disconnect(); intersection.disconnect();
    document.removeEventListener('visibilitychange', refresh);
    reduced.removeEventListener('change', refresh);
  };
}
