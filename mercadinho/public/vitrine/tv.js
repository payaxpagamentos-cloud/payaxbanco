import { el } from '../js/ui.js';
import { criarVitrine } from './vitrine.js';

/**
 * Página da TV: abre a vitrine em tela cheia e fica passando sozinha.
 * Basta abrir este endereço no navegador da TV (ou do computador ligado nela) e tocar em "Tela cheia".
 */
const vitrine = criarVitrine({ modo: 'tv' });
document.body.append(vitrine.elemento);
vitrine.iniciar();

/* Tela cheia: o navegador só deixa entrar depois de um clique ou toque. */
const botao = el('button', { class: 'tv-cheia', type: 'button' }, 'Tela cheia');
botao.addEventListener('click', () => document.documentElement.requestFullscreen?.().catch(() => {}));
document.addEventListener('fullscreenchange', () => { botao.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia'; });
document.body.append(botao);

/* O cursor e o botão somem depois de alguns segundos parados. */
let parado;
const mexeu = () => {
  document.body.classList.remove('sem-cursor');
  clearTimeout(parado);
  parado = setTimeout(() => document.body.classList.add('sem-cursor'), 3000);
};
['mousemove', 'pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, mexeu));
mexeu();

/* Pede para a tela não apagar sozinha (quando o navegador permite). */
let trava = null;
async function manterAcesa() {
  try { if (document.visibilityState === 'visible' && !trava) trava = await navigator.wakeLock?.request('screen'); } catch { /* sem permissão: segue */ }
  trava?.addEventListener?.('release', () => { trava = null; });
}
document.addEventListener('visibilitychange', manterAcesa);
manterAcesa();
