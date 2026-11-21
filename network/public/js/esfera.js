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
  const routes = [[0, 3], [0, 8], [1, 5], [2, 6], [3, 9], [4, 11], [5, 12], [6, 14], [7, 15], [8, 13], [9, 16], [10, 2], [11, 17], [12, 18], [13, 18], [15, 1]];

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

  const meridians = Array.from({ length: 7 }, (_, i) => {
    const longitude = i * Math.PI / 7;
    return Array.from({ length: 97 }, (_, j) => {
      const t = j * Math.PI * 2 / 96;
      return { x: Math.cos(t) * Math.cos(longitude), y: Math.sin(t), z: Math.cos(t) * Math.sin(longitude) };
    });
  });
  const parallels = [-0.6, -0.28, 0.06, 0.42].map(y =>
    Array.from({ length: 97 }, (_, j) => {
      const t = j * Math.PI * 2 / 96, r = Math.sqrt(1 - y * y);
      return { x: Math.cos(t) * r, y, z: Math.sin(t) * r };
    })
  );
  /*
   * Faixas de luz que circundam a esfera. Na arte elas rasam a superfície: um anel quase horizontal e
   * outro inclinado. Raio só um pouco maior que o da esfera — passando longe, viravam dois arcos soltos.
   */
  const orbits = [[-0.30, 1.09], [0.62, 1.03]].map(([tilt, escala]) =>
    Array.from({ length: 161 }, (_, j) => {
      const t = j * Math.PI * 2 / 160;
      return {
        x: Math.cos(t) * escala,
        y: Math.sin(t) * Math.sin(tilt) * escala,
        z: Math.sin(t) * Math.cos(tilt) * escala,
      };
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
    const radius = Math.min(width, height) * 0.345;
    const cx = width * 0.5, cy = height * 0.48;
    ctx.clearRect(0, 0, width, height);

    const halo = ctx.createRadialGradient(cx, cy, radius * 0.25, cx, cy, radius * 1.85);
    halo.addColorStop(0, 'rgba(62,245,165,.26)');
    halo.addColorStop(0.38, 'rgba(38,210,138,.14)');
    halo.addColorStop(0.72, 'rgba(23,175,114,.055)');
    halo.addColorStop(1, 'rgba(0,90,57,0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, width, height);

    ctx.save(); ctx.translate(cx, cy + radius * 1.07); ctx.scale(1, 0.13);
    const ground = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 1.1);
    ground.addColorStop(0, 'rgba(120,255,186,.58)');
    ground.addColorStop(0.35, 'rgba(50,232,155,.20)');
    ground.addColorStop(1, 'rgba(0,98,58,0)');
    ctx.fillStyle = ground; ctx.beginPath(); ctx.arc(0, 0, radius * 1.1, 0, Math.PI * 2); ctx.fill(); ctx.restore();

    orbits.forEach(points => curve(points, radius, false, 'rgba(89,239,175,.22)', 1.3, angle * 0.22));
    /*
     * O corpo de vidro. O interior é mais ESCURO que o fundo de propósito: é o que faz a esfera ler como
     * um objeto com volume, em vez de um emaranhado de linhas no ar. O realce vem do alto à esquerda e a
     * borda acende, como no vidro da arte.
     */
    const glass = ctx.createRadialGradient(cx - radius * 0.42, cy - radius * 0.52, radius * 0.05, cx, cy, radius * 1.08);
    glass.addColorStop(0, 'rgba(188,255,226,.26)');
    glass.addColorStop(0.18, 'rgba(60,180,132,.13)');
    glass.addColorStop(0.46, 'rgba(2,34,23,.56)');
    glass.addColorStop(0.78, 'rgba(3,46,31,.62)');
    glass.addColorStop(0.93, 'rgba(60,190,140,.30)');
    glass.addColorStop(1, 'rgba(214,255,238,.52)');
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fillStyle = glass; ctx.fill();

    for (const front of [false, true]) {
      for (const points of [...meridians, ...parallels]) curve(points, radius, front, front ? 'rgba(140,245,198,.17)' : 'rgba(112,241,190,.05)', 0.65);
      for (const points of arcs) {
        if (front) { ctx.save(); ctx.shadowBlur = 9; ctx.shadowColor = '#7dffc0'; }
        curve(points, radius * 1.003, front, front ? 'rgba(176,255,214,.78)' : 'rgba(90,211,160,.05)', front ? 1.15 : 0.7);
        if (front) ctx.restore();
      }
    }
    const rim = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    rim.addColorStop(0, 'rgba(226,255,243,.95)');
    rim.addColorStop(0.3, 'rgba(130,245,195,.42)');
    rim.addColorStop(0.68, 'rgba(104,226,176,.34)');
    rim.addColorStop(1, 'rgba(206,255,232,.92)');
    ctx.save(); ctx.shadowBlur = 18; ctx.shadowColor = 'rgba(120,255,195,.5)';
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.strokeStyle = rim; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.ellipse(cx - radius * 0.07, cy, radius * 0.85, radius * 1.01, -0.36, Math.PI * 0.97, Math.PI * 1.73);
    ctx.strokeStyle = 'rgba(210,255,234,.27)'; ctx.lineWidth = 1; ctx.stroke();

    // Luz presa dentro do vidro, concentrada na base: é o que dá a sensação de objeto aceso por dentro.
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.clip();
    const interno = ctx.createRadialGradient(cx - radius * 0.1, cy + radius * 0.55, 0, cx, cy + radius * 0.3, radius * 1.15);
    interno.addColorStop(0, 'rgba(142,255,200,.30)');
    interno.addColorStop(0.42, 'rgba(60,226,152,.11)');
    interno.addColorStop(1, 'rgba(40,200,130,0)');
    ctx.fillStyle = interno; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();

    for (const points of orbits) {
      ctx.save(); ctx.shadowBlur = 30; ctx.shadowColor = '#5cffaa';
      // Três passagens: o brilho largo, o corpo da faixa e o fio branco no meio.
      curve(points, radius, true, 'rgba(70,228,142,.38)', 5.2, angle * 0.22);
      curve(points, radius, true, 'rgba(120,246,175,.86)', 2.1, angle * 0.22);
      ctx.shadowBlur = 14;
      curve(points, radius, true, 'rgba(236,255,243,.95)', 0.8, angle * 0.22); ctx.restore();
    }
    for (const node of nodes) {
      const p = project(node, radius * 1.005);
      if (p.z < 0) continue;
      const size = 1.5 + p.z * 2.6;
      ctx.save();
      // Auréola larga primeiro, depois o núcleo: é o que faz o nó parecer luz, e não tinta.
      const brilho = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 5);
      brilho.addColorStop(0, 'rgba(190,255,220,.55)');
      brilho.addColorStop(0.45, 'rgba(90,240,170,.17)');
      brilho.addColorStop(1, 'rgba(60,220,150,0)');
      ctx.fillStyle = brilho; ctx.beginPath(); ctx.arc(p.x, p.y, size * 5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 16; ctx.shadowColor = '#8affc9';
      ctx.fillStyle = '#eafff2'; ctx.beginPath(); ctx.arc(p.x, p.y, size, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
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
