import { api } from './api.js';
import { html, $, $$ } from '../../js/ui.js';

const TAMANHO = 6;

function pontos(qtd) {
  return html`<div class="tecl-pontos" aria-hidden="true">${Array.from({ length: TAMANHO }, (_, i) => html`<span class="${i < qtd ? 'cheio' : ''}"></span>`)}</div>`;
}

/**
 * Teclado de pares sorteado pelo servidor (ex.: "1 ou 4"). Guarda só os botões clicados.
 * Retorna { valor(), completo(), renovar(), aoMudar }.
 */
export function tecladoPares(el, { rotulo = 'Senha', aoMudar } = {}) {
  let desafio = null;
  let sequencia = [];
  const desenhar = () => {
    el.innerHTML = String(html`<div class="teclado">
      <div class="tecl-rotulo">${rotulo}</div>
      ${pontos(sequencia.length)}
      <div class="tecl-botoes" role="group" aria-label="${rotulo}: teclado virtual">
        ${desafio ? desafio.teclas.map((par, i) => html`<button type="button" class="tecl-par" data-i="${i}" aria-label="${par[0]} ou ${par[1]}">${par[0]} <small>ou</small> ${par[1]}</button>`)
          : html`<div class="muted small" style="grid-column:1/-1;text-align:center;padding:12px">Carregando teclado…</div>`}
        <button type="button" class="tecl-apagar" data-apagar aria-label="Apagar">⌫ Apagar</button>
      </div></div>`);
    $$('[data-i]', el).forEach((b) => b.addEventListener('click', () => {
      if (sequencia.length >= TAMANHO) return;
      sequencia.push(Number(b.dataset.i));
      atualizar();
    }));
    $('[data-apagar]', el).addEventListener('click', () => { sequencia.pop(); atualizar(); });
  };
  const atualizar = () => {
    const p = $('.tecl-pontos', el);
    if (p) p.outerHTML = String(pontos(sequencia.length));
    aoMudar?.(sequencia.length === TAMANHO);
  };
  const renovar = async () => {
    sequencia = [];
    desafio = null;
    desenhar();
    aoMudar?.(false);
    desafio = await api.post('/auth/teclado');
    desenhar();
  };
  renovar();
  return {
    completo: () => Boolean(desafio) && sequencia.length === TAMANHO,
    valor: () => ({ teclado_id: desafio?.id, sequencia: [...sequencia] }),
    renovar,
  };
}

/** Teclado simples com dígitos embaralhados, para cadastrar senha nova. Retorna { valor(), limpar() }. */
export function tecladoSimples(el, { rotulo, aoCompletar } = {}) {
  let digitos = '';
  const ordem = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const r = new Uint32Array(10);
  crypto.getRandomValues(r);
  for (let i = 9; i > 0; i--) { const j = r[i] % (i + 1); [ordem[i], ordem[j]] = [ordem[j], ordem[i]]; }
  el.innerHTML = String(html`<div class="teclado">
    <div class="tecl-rotulo">${rotulo}</div>
    ${pontos(0)}
    <div class="tecl-botoes simples" role="group" aria-label="${rotulo}: teclado numérico">
      ${ordem.map((d) => html`<button type="button" class="tecl-par" data-d="${d}">${d}</button>`)}
      <button type="button" class="tecl-apagar" data-apagar aria-label="Apagar">⌫</button>
    </div></div>`);
  const atualizar = () => {
    $('.tecl-pontos', el).outerHTML = String(pontos(digitos.length));
    if (digitos.length === TAMANHO) aoCompletar?.(digitos);
  };
  $$('[data-d]', el).forEach((b) => b.addEventListener('click', () => {
    if (digitos.length >= TAMANHO) return;
    digitos += b.dataset.d;
    atualizar();
  }));
  $('[data-apagar]', el).addEventListener('click', () => { digitos = digitos.slice(0, -1); atualizar(); });
  return { valor: () => digitos, limpar: () => { digitos = ''; atualizar(); } };
}

/**
 * Assistente para criar uma senha nova: digita e confirma no teclado simples.
 * Resolve com os 6 dígitos quando as duas digitações conferem.
 */
export function criarSenhaNova(el, { rotulo, ajuda }) {
  return new Promise((resolve) => {
    const etapa = (titulo, erro, aoFim) => {
      el.innerHTML = String(html`${ajuda ? html`<p class="small muted" style="margin:0 0 10px">${ajuda}</p>` : ''}${erro ? html`<div class="erro-form">${erro}</div>` : ''}<div data-t></div>`);
      tecladoSimples($('[data-t]', el), { rotulo: titulo, aoCompletar: aoFim });
    };
    const inicio = (erro) => etapa(`Crie sua ${rotulo}`, erro, (primeira) => {
      setTimeout(() => etapa(`Confirme sua ${rotulo}`, null, (segunda) => {
        if (segunda === primeira) resolve(primeira);
        else setTimeout(() => inicio('As senhas não conferem. Tente novamente.'), 150);
      }), 150);
    });
    inicio();
  });
}
