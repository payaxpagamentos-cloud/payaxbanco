/**
 * Efeitos do visual: a luz que segue o mouse nos cartões e os números dos indicadores contando até o valor quando a página abre.
 * Para quem pediu "menos movimento" no sistema, os números aparecem prontos.
 */
const parado = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Luz nos cartões: a posição do mouse vira --mx / --my no cartão embaixo dele.
document.addEventListener('pointermove', (e) => {
  const c = e.target instanceof Element ? e.target.closest('.cartao') : null;
  if (!c) return;
  const r = c.getBoundingClientRect();
  c.style.setProperty('--mx', `${e.clientX - r.left}px`);
  c.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });

// Números inteiros (com ou sem ponto de milhar e com um texto depois, como "12 km") contam de 0 até o valor.
const NUMERO = /^(\d{1,3}(?:\.\d{3})+|\d+)(\s*\D{0,12})$/;
function contar(elv) {
  const m = NUMERO.exec(elv.textContent.trim());
  if (!m) return;
  const fim = Number(m[1].replace(/\./g, ''));
  if (!Number.isFinite(fim) || fim === 0) return;
  const sufixo = m[2];
  const duracao = Math.min(1400, 500 + fim * 8);
  const inicio = performance.now();
  const passo = (t) => {
    if (!elv.isConnected) return;
    const p = Math.min(1, (t - inicio) / duracao);
    const atual = Math.round(fim * (1 - (1 - p) ** 3));
    elv.textContent = `${atual.toLocaleString('pt-BR')}${sufixo}`;
    if (p < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

new MutationObserver((mudancas) => {
  if (parado()) return;
  for (const mu of mudancas) {
    for (const n of mu.addedNodes) {
      if (!(n instanceof Element)) continue;
      const valores = n.matches('.indicador .valor') ? [n] : n.querySelectorAll('.indicador .valor');
      for (const v of valores) {
        // Os quadrinhos do painel do veículo se atualizam sozinhos: ficam sem contagem para não piscar.
        if (v.dataset.contado || v.closest('.grade.mini')) continue;
        v.dataset.contado = '1';
        contar(v);
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });
