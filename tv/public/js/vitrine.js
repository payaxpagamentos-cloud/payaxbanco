import { arte } from './api.js';
import { iconeLinha } from './login-icones.js';

const POR_GRUPO = 4;
const INTERVALO_MS = 6000;   // tempo de cada grupo na tela
const FADE_MS = 650;         // precisa casar com a transição de .poster-page no CSS

/**
 * Carrossel de cartazes da tela de entrada.
 *
 * Mostra quatro títulos e troca pelos quatro seguintes a cada 6 s, em crossfade de 650 ms.
 * Usa duas camadas sobrepostas: a que entra já está montada antes de aparecer, então nenhuma
 * moldura fica vazia no meio da transição.
 *
 * Para de girar com o mouse em cima, com o foco do teclado dentro, com a aba em segundo plano
 * ou no botão de pausa. Quem pede menos movimento no sistema começa pausado, e pode dar play.
 *
 * @param {Array<{id:number,nome:string,capa:number}>} titulos vitrine vinda de /api/publico
 * @returns {{elemento: HTMLElement, destruir: () => void}|null} null quando não há título algum
 */
export function carrosselEntrada(titulos) {
  const filmes = normalizar(titulos);
  if (!filmes.length) return null;

  const camadas = [montarCamada(), montarCamada()];
  const palco = el('div', 'poster-stage', camadas);
  const pontos = el('div', 'catalogue-dots');
  const anterior = botaoIcone('chevron-left', 'Grupo anterior de filmes');
  const pausa = botaoIcone('pause', 'Pausar troca automática');
  const proximo = botaoIcone('chevron-right', 'Próximo grupo de filmes');
  const controles = el('div', 'catalogue-controls', [pontos, el('div', 'playback-controls', [anterior, pausa, proximo])]);
  const aviso = el('p', 'sr-only');
  aviso.setAttribute('aria-live', 'polite');
  aviso.setAttribute('aria-atomic', 'true');

  const raiz = el('section', 'catalogue', [palco, controles, aviso]);
  raiz.setAttribute('aria-label', 'Filmes em destaque');
  raiz.setAttribute('aria-roledescription', 'carrossel');

  const movimento = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const grupos = agrupar(filmes);
  let atual = 0;
  let camadaAtiva = 0;
  let relogio = null;
  let sobre = false;     // mouse em cima
  let comFoco = false;   // foco do teclado dentro
  let pausado = movimento?.matches ?? false;
  let morto = false;

  const parar = () => { window.clearTimeout(relogio); relogio = null; };
  const agendar = () => {
    parar();
    if (morto || grupos.length < 2 || pausado || sobre || comFoco || document.hidden) return;
    relogio = window.setTimeout(() => mostrar(atual + 1), INTERVALO_MS);
  };

  const atualizarControles = () => {
    [...pontos.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === atual)));
    pausa.setAttribute('aria-label', pausado ? 'Retomar troca automática' : 'Pausar troca automática');
    pausa.setAttribute('aria-pressed', String(pausado));
    pausa.replaceChildren(iconeLinha(pausado ? 'play' : 'pause'));
  };

  const mostrar = (indice, manual = false) => {
    if (morto || !grupos.length) return;
    const alvo = ((indice % grupos.length) + grupos.length) % grupos.length;
    if (alvo !== atual || !camadas[camadaAtiva].children.length) {
      const entrando = camadas[1 - camadaAtiva];
      entrando.replaceChildren(...grupos[alvo].map(cartaz));
      void entrando.offsetWidth;  // força o quadro inicial com opacidade zero antes do fade
      camadas[camadaAtiva].classList.remove('is-active');
      camadas[camadaAtiva].setAttribute('aria-hidden', 'true');
      entrando.classList.add('is-active');
      entrando.removeAttribute('aria-hidden');
      camadaAtiva = 1 - camadaAtiva;
      atual = alvo;
    }
    atualizarControles();
    if (manual) aviso.textContent = `Grupo ${atual + 1} de ${grupos.length}: ${grupos[atual].map((f) => f.nome).join(', ')}.`;
    agendar();
  };

  camadas[0].replaceChildren(...grupos[0].map(cartaz));
  camadas[0].classList.add('is-active');
  camadas[0].removeAttribute('aria-hidden');
  // O grupo seguinte já fica montado atrás, para o crossfade não começar com molduras vazias.
  camadas[1].replaceChildren(...(grupos[1] ?? []).map(cartaz));

  pontos.replaceChildren(...grupos.map((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Exibir grupo ${i + 1} de ${grupos.length}`);
    b.addEventListener('click', () => mostrar(i, true));
    return b;
  }));
  controles.hidden = grupos.length < 2;
  atualizarControles();
  agendar();

  const ouvintes = [];
  const ouvir = (alvo, evento, mao) => { alvo.addEventListener(evento, mao); ouvintes.push(() => alvo.removeEventListener(evento, mao)); };

  ouvir(raiz, 'mouseenter', () => { sobre = true; parar(); });
  ouvir(raiz, 'mouseleave', () => { sobre = false; agendar(); });
  ouvir(raiz, 'focusin', () => { comFoco = true; parar(); });
  ouvir(raiz, 'focusout', () => queueMicrotask(() => { comFoco = raiz.contains(document.activeElement); agendar(); }));
  ouvir(document, 'visibilitychange', agendar);
  if (movimento) ouvir(movimento, 'change', () => { if (movimento.matches) pausado = true; atualizarControles(); agendar(); });
  ouvir(pausa, 'click', () => { pausado = !pausado; atualizarControles(); agendar(); });
  ouvir(proximo, 'click', () => mostrar(atual + 1, true));
  ouvir(anterior, 'click', () => mostrar(atual - 1, true));

  const destruir = () => { morto = true; parar(); ouvintes.forEach((f) => f()); };
  // Rede de segurança: se a tela for trocada sem chamar destruir(), o relógio para sozinho.
  const vigia = setInterval(() => {
    if (!raiz.isConnected) { destruir(); clearInterval(vigia); }
  }, INTERVALO_MS);
  ouvintes.push(() => clearInterval(vigia));

  return { elemento: raiz, destruir };
}

// ---------- apoio ----------

function el(tag, classe, filhos) {
  const n = document.createElement(tag);
  if (classe) n.className = classe;
  if (filhos) n.append(...[].concat(filhos));
  return n;
}

function botaoIcone(nome, rotulo) {
  const b = el('button', 'icon-button', iconeLinha(nome));
  b.type = 'button';
  b.setAttribute('aria-label', rotulo);
  return b;
}

function montarCamada() {
  const ul = el('ul', 'poster-page');
  ul.setAttribute('aria-label', 'Grupo de filmes');
  ul.setAttribute('aria-hidden', 'true');
  return ul;
}

/** Descarta item sem nome e repetido; mantém a ordem que veio do servidor. */
function normalizar(itens) {
  if (!Array.isArray(itens)) return [];
  const vistos = new Set();
  return itens.filter((f) => {
    if (!f || typeof f.nome !== 'string' || !f.nome.trim()) return false;
    const chave = String(f.id ?? f.nome);
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  }).map((f) => ({ ...f, nome: f.nome.trim() }));
}

/**
 * Quebra a lista em grupos de quatro. O último grupo é completado voltando ao começo, e com
 * quatro títulos ou menos sai um grupo só — aí não há o que girar e o relógio nem começa.
 */
function agrupar(filmes) {
  const quantos = Math.min(POR_GRUPO, filmes.length);
  return Array.from({ length: Math.ceil(filmes.length / POR_GRUPO) }, (_, g) =>
    Array.from({ length: quantos }, (_, i) => filmes[(g * POR_GRUPO + i) % filmes.length]));
}

/** Cartaz: a capa entra por cima de um fundo com o nome, que fica visível se a imagem falhar. */
function cartaz(filme) {
  const li = document.createElement('li');
  li.dataset.tituloId = String(filme.id ?? '');

  const cartao = el('div', 'movie-poster');
  cartao.setAttribute('role', 'img');
  cartao.setAttribute('aria-label', filme.nome);

  const reserva = el('div', 'poster-fallback', [iconeLinha('film'), el('span', null, document.createTextNode(filme.nome))]);
  reserva.setAttribute('aria-hidden', 'true');
  cartao.append(reserva);

  const url = arte(filme.capa);
  if (url) {
    const img = new Image();
    img.className = 'poster-image';
    img.alt = '';
    img.decoding = 'async';
    img.setAttribute('aria-hidden', 'true');
    img.addEventListener('error', () => img.remove(), { once: true });
    img.src = url;
    cartao.append(img);
  }
  li.append(cartao);
  return li;
}
