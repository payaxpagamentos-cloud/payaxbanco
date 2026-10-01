/** Contagem regressiva até um horário do banco (texto "AAAA-MM-DD HH:MM:SS" em UTC). */
const instante = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);

export function restante(ate) {
  const seg = Math.max(0, Math.round((instante(ate) - Date.now()) / 1000));
  if (seg === 0) return 'em instantes';
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, '0')} min ${String(seg % 60).padStart(2, '0')} s`;
  if (m) return `${m} min ${String(seg % 60).padStart(2, '0')} s`;
  return `${seg} s`;
}

/** Fração do prazo já decorrida (0 a 1), para a barra de progresso. */
export function decorrido(desde, ate) {
  const total = instante(ate) - instante(desde);
  return total > 0 ? Math.min(1, Math.max(0, (Date.now() - instante(desde)) / total)) : 1;
}

/**
 * Atualiza a cada segundo os elementos [data-prazo-ate] (texto do tempo que falta) e [data-prazo-barra]
 * (largura da barra). Ao terminar o prazo chama `aoTerminar` uma vez. Para sozinho quando a tela sai.
 */
export function ligarContagens(raiz, aoTerminar) {
  const els = [...raiz.querySelectorAll('[data-prazo-ate]')];
  if (!els.length) return;
  let avisou = false;
  const tick = () => {
    if (!els[0].isConnected) { clearInterval(timer); return; }
    for (const el of els) {
      el.textContent = restante(el.dataset.prazoAte);
      const barra = raiz.querySelector(`[data-prazo-barra="${el.dataset.prazoAte}"]`);
      if (barra) barra.style.width = `${(decorrido(barra.dataset.desde, el.dataset.prazoAte) * 100).toFixed(1)}%`;
      if (!avisou && instante(el.dataset.prazoAte) <= Date.now()) { avisou = true; aoTerminar?.(); }
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
}
