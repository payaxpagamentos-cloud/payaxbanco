// Caminho até a raiz do site a partir da página do Internet Banking (padrão: /ib/ → '../').
// Uma publicação em que o Internet Banking é a página principal define window.PAYAX_RAIZ = ''.
export const RAIZ = window.PAYAX_RAIZ ?? '../';

// Endereço do site institucional (para o link "Voltar ao site"). Publicações sem o site definem null.
export const SITE = window.PAYAX_SITE === undefined ? `${RAIZ}site/index.html` : window.PAYAX_SITE;

// Aberto por cima do site institucional (iframe com ?embutido=1): o site cuida do fundo e de fechar a janela.
export const EMBUTIDO = window.parent !== window && new URLSearchParams(location.search).has('embutido');

/** Avisa o site institucional: 'fechar' (fechar a janela), 'logado' (tela cheia) ou 'deslogado' (voltar ao login). */
export function avisarSite(evento) {
  if (EMBUTIDO) window.parent.postMessage({ payax: evento }, '*');
}
