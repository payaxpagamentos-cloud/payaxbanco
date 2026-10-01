// Caminho até a raiz do site a partir da página do Internet Banking (padrão: /ib/ → '../').
// Uma publicação em que o Internet Banking é a página principal define window.PAYAX_RAIZ = ''.
export const RAIZ = window.PAYAX_RAIZ ?? '../';

// Endereço do site institucional (para o link "Voltar ao site"). Publicações sem o site definem null.
export const SITE = window.PAYAX_SITE === undefined ? `${RAIZ}site/index.html` : window.PAYAX_SITE;
