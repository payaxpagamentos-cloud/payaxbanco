import { el, limpar, marca } from './ui.js';
import { BASE } from './api.js';
import { montarPainel } from './aovivo.js';

/**
 * A TV da supervisão: abre só o painel ao vivo, com o link da tela (tv.html#k=tv_…), sem login.
 * O link fica guardado no navegador da TV: se ela reiniciar na página sem o #k, continua funcionando.
 */
const GUARDA = 'zoe.tv';
const alvo = document.getElementById('tv');

function lerChave() {
  const doLink = new URLSearchParams(location.hash.slice(1)).get('k');
  if (doLink?.startsWith('tv_')) {
    try { localStorage.setItem(GUARDA, doLink); } catch { /* sem armazenamento: vale só nesta aba */ }
    return doLink;
  }
  try { return localStorage.getItem(GUARDA); } catch { return null; }
}

const aviso = (titulo, texto) => limpar(alvo, el('div', { class: 'entrada' }, el('div', { class: 'cartao', style: 'max-width:520px;text-align:center' },
  marca('ZOE'), el('h1', { style: 'margin:28px 0 8px;font-size:22px' }, titulo), el('p', { class: 'mudo', style: 'margin:0' }, texto))));

class ErroTv extends Error { constructor(m, status) { super(m); this.status = status; } }

const GUARDA_VISUAL = 'zoe.tv.visual';
/** Visual da TV: vem do link (&v=clean) e fica guardado, como a chave. */
function lerVisual() {
  const doLink = new URLSearchParams(location.hash.slice(1)).get('v');
  if (doLink) { try { localStorage.setItem(GUARDA_VISUAL, doLink); } catch { /* só nesta aba */ } return doLink === 'clean' ? 'clean' : 'completo'; }
  try { return localStorage.getItem(GUARDA_VISUAL) === 'clean' ? 'clean' : 'completo'; } catch { return 'completo'; }
}

const chave = lerChave();
if (!chave) {
  aviso('Link de TV necessário', 'Abra o endereço completo que aparece em Ao vivo › Links de TV, no painel da ZOE.');
} else {
  let visual = lerVisual();
  const painel = montarPainel(alvo, {
    tv: true,
    visual,
    buscar: async () => {
      let r;
      try { r = await fetch(`${BASE}/api/tv/ao-vivo`, { headers: { Authorization: `Bearer ${chave}` }, cache: 'no-store' }); } catch { throw new ErroTv('Sem conexão com o servidor.', 0); }
      if (!r.ok) {
        let msg = `Erro ${r.status}`;
        try { msg = (await r.json()).erro || msg; } catch { /* sem corpo */ }
        throw new ErroTv(msg, r.status);
      }
      return r.json();
    },
    aoFalhar: (err) => {
      if (err.status !== 401 && err.status !== 403) return null;
      try { localStorage.removeItem(GUARDA); } catch { /* ignora */ }
      aviso('Esta tela foi desligada', err.message);
      return 'parar';
    },
  });

  // A TV não pode apagar a tela nem mostrar o cursor parado no meio do painel.
  const manterAcesa = () => navigator.wakeLock?.request('screen').catch(() => {});
  manterAcesa();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') manterAcesa(); });
  let parado;
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('sem-cursor');
    clearTimeout(parado);
    parado = setTimeout(() => document.body.classList.add('sem-cursor'), 3000);
  });
  // Recarrega de madrugada para pegar versões novas do painel sem ninguém mexer na TV.
  setInterval(() => { if (new Date().getHours() === 4 && performance.now() > 3_600_000) location.reload(); }, 600_000);
  // Tecla V (no computador ligado na TV): alterna entre o visual completo e o clean, e guarda a escolha.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'v' && e.key !== 'V') return;
    visual = visual === 'clean' ? 'completo' : 'clean';
    try { localStorage.setItem(GUARDA_VISUAL, visual); } catch { /* só agora */ }
    painel.trocarVisual(visual);
  });
  // Duplo clique: tela cheia (no computador ligado na TV).
  document.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()).catch?.(() => {}));
}
