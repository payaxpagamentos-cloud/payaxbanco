import { html } from './ui.js';
import { PROPAGANDAS } from './propagandas.js';

const CHAVE = 'payax.vitrine.ultima';
const INTERVALO_MS = 7000;

/**
 * Vitrine de propagandas da PAY AX: começa numa peça diferente a cada acesso e troca sozinha.
 * `raizImg` é o caminho até public/img a partir da página (ex.: 'img/' ou '../img/').
 */
export function vitrine(el, { raizImg = 'img/', modo = 'cartao' } = {}) {
  const hero = modo === 'hero';
  const pecas = PROPAGANDAS;
  let ultima = -1;
  try { ultima = Number(localStorage.getItem(CHAVE) ?? -1); } catch { /* sem armazenamento */ }
  let atual = Math.floor(Math.random() * pecas.length);
  if (pecas.length > 1 && atual === ultima) atual = (atual + 1) % pecas.length;
  try { localStorage.setItem(CHAVE, String(atual)); } catch { /* ignora */ }

  el.innerHTML = String(html`
    <div class="vitrine" aria-roledescription="carrossel" aria-label="Novidades PAY AX">
      ${pecas.map((p, i) => (hero ? html`<div class="peca peca-hero ${i === atual ? 'ativa' : ''}" data-i="${i}" aria-hidden="${i === atual ? 'false' : 'true'}" style="--cor:${p.cor}">
          <img src="${raizImg}${p.largo ?? p.imagem}" alt="" class="${p.espelhar ? 'espelhada' : ''}">
          <div class="hero-sombra" aria-hidden="true"></div>
          <div class="hero-campanha"><span class="selo">${p.selo}</span><h2>${p.titulo}<span class="destaque">${p.destaque ?? ''}</span></h2><p>${p.texto}</p></div>
        </div>` : html`<div class="peca peca-foto ${i === atual ? 'ativa' : ''}" data-i="${i}" aria-hidden="${i === atual ? 'false' : 'true'}" style="--cor:${p.cor}">
          <div class="peca-midia"><img src="${raizImg}${p.imagem}" alt="" style="object-position:${p.foco ?? 'center'}"></div>
          <div class="peca-texto"><span class="selo">${p.selo}</span><h2>${p.titulo}<span class="destaque">${p.destaque ?? ''}</span></h2><p>${p.texto}</p></div>
        </div>`))}
      <div class="vitrine-pontos" role="tablist">${pecas.map((_, i) => html`<button type="button" role="tab" aria-label="Peça ${i + 1}" class="${i === atual ? 'ativo' : ''}" data-ir="${i}"></button>`)}</div>
    </div>`);

  const mostrar = (i) => {
    atual = (i + pecas.length) % pecas.length;
    el.querySelectorAll('.peca').forEach((p) => {
      const ativa = Number(p.dataset.i) === atual;
      p.classList.toggle('ativa', ativa);
      p.setAttribute('aria-hidden', ativa ? 'false' : 'true');
    });
    el.querySelectorAll('[data-ir]').forEach((b) => b.classList.toggle('ativo', Number(b.dataset.ir) === atual));
  };
  el.querySelectorAll('[data-ir]').forEach((b) => b.addEventListener('click', () => { mostrar(Number(b.dataset.ir)); reiniciar(); }));

  const reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer;
  const reiniciar = () => {
    clearInterval(timer);
    if (!reduzido && pecas.length > 1) timer = setInterval(() => { if (!el.isConnected) return clearInterval(timer); mostrar(atual + 1); }, INTERVALO_MS);
  };
  el.addEventListener('mouseenter', () => clearInterval(timer));
  el.addEventListener('mouseleave', reiniciar);
  reiniciar();
}
