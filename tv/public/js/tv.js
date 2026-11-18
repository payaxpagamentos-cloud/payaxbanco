/**
 * Modo TV: a PLAY TECH VIP aberta na Smart TV é operada pelo controle remoto, não pelo mouse.
 * Aqui ficam a detecção do aparelho, a navegação por setas (foco geométrico), o botão
 * Voltar das TVs e as teclas de mídia.
 *
 * Vale para Samsung (Tizen), LG (webOS), TCL/Android TV e para qualquer navegador aberto
 * com ?tv=1 (serve para testar no computador).
 */

const MARCAS_TV = /Tizen|Web0S|webOS|NetCast|SmartTV|SMART-TV|HbbTV|BRAVIA|AFT[BMNST]|GoogleTV|Android TV|CrKey|VIDAA|TCL|Hisense|Philips.*TV/i;

const guardado = (() => {
  try { return localStorage.getItem('playtechvip.modo') === 'tv'; } catch { return false; }
})();

const pedidoNaUrl = new URLSearchParams(window.location.search).has('tv');

/** Este aparelho é uma TV? */
export const ehTV = pedidoNaUrl || guardado || MARCAS_TV.test(navigator.userAgent);

if (ehTV) {
  try { localStorage.setItem('playtechvip.modo', 'tv'); } catch { /* sem armazenamento */ }
}

/** Nome do aparelho para a lista de telas em uso. */
export function nomeDaTV() {
  const ua = navigator.userAgent;
  if (/Tizen/i.test(ua)) return 'Samsung Smart TV';
  if (/Web0S|webOS|NetCast/i.test(ua)) return 'LG Smart TV';
  if (/VIDAA|Hisense/i.test(ua)) return 'Hisense/VIDAA';
  if (/TCL/i.test(ua)) return 'TCL Smart TV';
  if (/AFT[BMNST]/i.test(ua)) return 'Fire TV';
  if (/Android TV|GoogleTV/i.test(ua)) return 'Android TV';
  if (/BRAVIA/i.test(ua)) return 'Sony BRAVIA';
  return 'Smart TV';
}

// ---------------------------------------------------------------- foco

const FOCAVEIS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visivel = (e) => {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && e.offsetParent !== null;
};

/** Candidatos ao foco, dentro da janela aberta (modal ou player) quando houver uma. */
function candidatos() {
  const escopo = document.querySelector('.modal-fundo') ?? document.querySelector('.player') ?? document;
  return [...escopo.querySelectorAll(FOCAVEIS)].filter(visivel);
}

const centro = (e) => {
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
};

/**
 * Próximo elemento na direção pedida: entre os que estão do lado certo, escolhe o mais
 * próximo, penalizando quem está desalinhado (é assim que o foco "anda em linha reta" na TV).
 */
function vizinho(dir) {
  const atual = document.activeElement;
  const lista = candidatos();
  if (!lista.length) return null;
  if (!atual || atual === document.body || !lista.includes(atual)) return lista[0];
  const a = centro(atual);
  let melhor = null;
  let melhorNota = Infinity;
  for (const e of lista) {
    if (e === atual) continue;
    const b = centro(e);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const naDirecao = { ArrowRight: dx > 8, ArrowLeft: dx < -8, ArrowDown: dy > 8, ArrowUp: dy < -8 }[dir];
    if (!naDirecao) continue;
    const horizontal = dir === 'ArrowLeft' || dir === 'ArrowRight';
    const distancia = Math.abs(horizontal ? dx : dy);
    const desvio = Math.abs(horizontal ? dy : dx);
    const nota = distancia + desvio * 2.5;
    if (nota < melhorNota) { melhorNota = nota; melhor = e; }
  }
  return melhor;
}

function focar(e) {
  if (!e) return;
  e.focus({ preventScroll: true });
  e.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

/** Põe o foco no primeiro item da tela (chamado a cada troca de página). */
export function focarPrimeiro(raiz = document) {
  if (!ehTV) return;
  // Espera o navegador desenhar antes de medir as posições.
  requestAnimationFrame(() => {
    const dentro = raiz.querySelector?.('.modal-fundo') ?? raiz;
    const lista = [...(dentro.querySelectorAll?.(FOCAVEIS) ?? [])].filter(visivel);
    const preferido = lista.find((e) => e.classList.contains('primario') || e.classList.contains('claro') || e.classList.contains('cartaz'));
    focar(preferido ?? lista[0]);
  });
}

// ---------------------------------------------------------------- teclas do controle

const TECLAS_VOLTAR = new Set([10009, 461, 8]); // Tizen, webOS e Backspace
const TECLAS_MIDIA = {
  415: 'tocar', 19: 'pausar', 10252: 'alternar', 413: 'parar', 417: 'avancar', 412: 'voltar',
  MediaPlay: 'tocar', MediaPause: 'pausar', MediaPlayPause: 'alternar', MediaStop: 'parar',
  MediaFastForward: 'avancar', MediaTrackNext: 'avancar', MediaRewind: 'voltar', MediaTrackPrevious: 'voltar',
};

/** Fecha o app na TV (cada fabricante tem o seu jeito). */
function sairDoApp() {
  try {
    if (window.tizen?.application) return window.tizen.application.getCurrentApplication().exit();
    if (window.webOS?.platformBack) return window.webOS.platformBack();
  } catch { /* segue */ }
  return window.close();
}

/**
 * Liga o controle remoto. `aoVoltar` recebe o pedido de voltar e devolve true quando já
 * tratou (por exemplo, fechou o player); devolvendo false na tela inicial, o app fecha.
 */
export function ligarControle({ aoVoltar, aoMidia } = {}) {
  if (!ehTV) return () => {};
  document.body.classList.add('tv');

  const tecla = (e) => {
    const emCampo = e.target.matches?.('input, textarea, select');

    if (TECLAS_VOLTAR.has(e.keyCode) || e.key === 'XF86Back' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !emCampo)) {
      e.preventDefault();
      if (!aoVoltar?.()) sairDoApp();
      return;
    }

    const midia = TECLAS_MIDIA[e.keyCode] ?? TECLAS_MIDIA[e.key];
    if (midia) {
      e.preventDefault();
      aoMidia?.(midia);
      return;
    }

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      // Dentro do player, as setas controlam o vídeo (o próprio player trata).
      if (document.querySelector('.player') && !document.querySelector('.modal-fundo')) return;
      if (emCampo && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      const alvo = vizinho(e.key);
      if (alvo) {
        e.preventDefault();
        focar(alvo);
      }
      return;
    }

    if (e.key === 'Enter' && document.activeElement === document.body) {
      const lista = candidatos();
      if (lista.length) {
        e.preventDefault();
        focar(lista[0]);
      }
    }
  };

  document.addEventListener('keydown', tecla, true);
  return () => document.removeEventListener('keydown', tecla, true);
}
