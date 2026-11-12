import { el } from '../js/ui.js';
import { criarVitrine } from './vitrine.js';

/**
 * Página da TV: a vitrine em tela cheia, passando sozinha.
 * Controles: tela cheia, pausar, anterior e próxima (somem depois de 4,5 s sem mexer).
 * Atalhos: F = tela cheia · espaço = pausar/retomar · setas = anterior/próxima.
 */
const contador = el('small');
const pausar = el('button', { type: 'button' }, 'Pausar');
const anterior = el('button', { type: 'button', 'aria-label': 'Quadro anterior' }, '←');
const proxima = el('button', { type: 'button', 'aria-label': 'Próximo quadro' }, '→');
const telaCheia = el('button', { type: 'button', class: 'tela-cheia' }, 'Tela cheia');

const vitrine = criarVitrine({
  modo: 'tv',
  aoMudar: ({ atual, total, pausada }) => {
    contador.textContent = total ? `${atual + 1} / ${total}` : '';
    pausar.textContent = pausada ? 'Reproduzir' : 'Pausar';
    pausar.setAttribute('aria-label', pausada ? 'Retomar a apresentação' : 'Pausar a apresentação');
    anterior.disabled = proxima.disabled = total < 2;
  },
});
const controles = el('nav', { class: 'tv-controles', 'aria-label': 'Controles da vitrine' },
  el('span', { class: 'marca' }, 'Mercado Binho', contador), anterior, pausar, proxima, telaCheia);
document.body.append(vitrine.elemento, controles);
vitrine.iniciar();

const alternarPausa = () => (vitrine.pausada ? vitrine.retomar() : vitrine.pausar());
async function alternarTelaCheia() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else telaCheia.textContent = 'Use a tela cheia da TV';
  } catch {
    telaCheia.textContent = 'Use a tela cheia do navegador';
  }
}
pausar.addEventListener('click', alternarPausa);
anterior.addEventListener('click', () => vitrine.anterior());
proxima.addEventListener('click', () => vitrine.proximo());
telaCheia.addEventListener('click', alternarTelaCheia);
document.addEventListener('fullscreenchange', () => { telaCheia.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia'; });

/* Controles e cursor somem depois de 4,5 s parados. Com controle remoto/teclado, ficam enquanto houver foco neles. */
let parado;
function mostrarControles() {
  document.body.classList.remove('parado');
  clearTimeout(parado);
  parado = setTimeout(() => {
    if (document.body.classList.contains('teclado') && controles.contains(document.activeElement)) return;
    document.body.classList.add('parado');
  }, 4500);
}
document.addEventListener('mousemove', mostrarControles, { passive: true });
document.addEventListener('pointerdown', () => { document.body.classList.remove('teclado'); mostrarControles(); }, { passive: true });
document.addEventListener('focusin', mostrarControles);
document.addEventListener('keydown', (e) => {
  document.body.classList.add('teclado');
  mostrarControles();
  if (e.key === 'ArrowRight') { e.preventDefault(); vitrine.proximo(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); vitrine.anterior(); }
  if (e.key.toLowerCase() === 'f') { e.preventDefault(); alternarTelaCheia(); }
  if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); alternarPausa(); }
});
mostrarControles();

/* Ao voltar para a aba, pula direto para o quadro certo; e pede para a tela não apagar. */
let trava = null;
async function manterAcesa() {
  try { if (document.visibilityState === 'visible' && !trava) trava = await navigator.wakeLock?.request('screen'); } catch { /* sem permissão: segue */ }
  trava?.addEventListener?.('release', () => { trava = null; });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { vitrine.acertar(); manterAcesa(); } });
manterAcesa();
