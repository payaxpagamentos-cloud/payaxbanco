import { el, limpar, dinheiro, iniciais, RAIZ } from '../js/ui.js';

/**
 * Vitrine: artes, vídeos, ofertas e produtos passando sozinhos, em tela cheia.
 * Roda na TV da loja (página /vitrine/) e no terminal de autoatendimento quando nenhum cliente está comprando.
 *
 * Cada quadro tem duração conhecida (o servidor manda). Com isso, quando "sincronizar" está ligado, toda
 * tela calcula pelo relógio qual quadro deve estar no ar — várias TVs ficam no mesmo quadro e trocam juntas,
 * mesmo ligadas em horários diferentes. A precisão é a do relógio de cada aparelho; não é quadro a quadro.
 *
 * A sequência é buscada de novo a cada volta: oferta nova, vídeo novo ou preço novo entram sem recarregar.
 */
const FADE_MS = 800;
const EPOCA = 0; // referência comum a todas as TVs
const SUFIXO = { kg: '/kg', l: '/litro' };
const dataCurta = (iso) => (iso ? iso.split('-').reverse().slice(0, 2).join('/') : '');
const assinatura = (lista) => JSON.stringify(lista.map((s) => [s.tipo, s.id, s.arquivo, s.preco_centavos, s.preco_cheio_centavos, s.selo, s.duracao_ms]));

export function criarVitrine({ modo = 'tv', aoMudar = null } = {}) {
  const palco = el('div', { class: 'vt-palco', role: 'region', 'aria-roledescription': 'carrossel', 'aria-label': 'Vitrine do Mercado Binho' });
  const elemento = el('div', { class: `vitrine vt-${modo}` }, palco,
    modo === 'tablet' ? el('div', { class: 'vt-chamada' }, el('i', { class: 'vt-pulso' }), 'Toque na tela ou passe um produto no leitor para começar') : null);

  let lista = [];
  let agenda = [];
  let total = 0;
  let dados = null;
  let atual = -1;
  let quadroAtual = null;
  let ligada = false;
  let pausada = false;
  let relogio = null;
  let proximaTroca = 0; // modo sem sincronismo
  let buscando = false;
  let ultimaBusca = 0;

  async function carregar() {
    ultimaBusca = Date.now();
    try {
      const r = await fetch(`${RAIZ}/api/vitrine`, { cache: 'no-store' });
      if (!r.ok) return false; // segue com a sequência que já tinha: a TV não apaga porque o servidor piscou
      const novo = await r.json();
      const mudou = assinatura(novo.slides ?? []) !== assinatura(lista);
      dados = novo;
      if (mudou) {
        lista = novo.slides ?? [];
        let t = 0;
        agenda = lista.map((s) => { const a = { inicio: t, dur: Math.max(3000, s.duracao_ms || 12000) }; t += a.dur; return a; });
        total = t;
      }
      return mudou;
    } catch {
      return false; // sem rede: segue com o que já tinha
    }
  }

  const sincronizar = () => dados?.sincronizar !== false;

  /** Qual quadro deve estar no ar agora, e há quanto tempo, pelo relógio. */
  function pelaHora(agora = Date.now()) {
    if (!total) return { indice: -1, decorrido: 0 };
    const p = (((agora - EPOCA) % total) + total) % total;
    const indice = agenda.findIndex((a) => p >= a.inicio && p < a.inicio + a.dur);
    return { indice, decorrido: p - agenda[indice].inicio };
  }

  /* ---------- quadros ---------- */
  function quadroProduto(s) {
    const nome = dados?.mercado?.nome || 'Mercado Binho';
    return el('article', { class: `vt-quadro vt-produto vt-${s.destaque}` },
      el('div', { class: 'vt-onda vt-onda-cima', 'aria-hidden': 'true' }),
      el('div', { class: 'vt-onda vt-onda-baixo', 'aria-hidden': 'true' }),
      el('img', { class: 'vt-logo', src: `${RAIZ}/img/binho-logo.png`, alt: nome }),
      el('div', { class: 'vt-texto' },
        el('span', { class: 'vt-selo' }, s.selo),
        el('h2', { class: 'vt-nome' }, s.nome),
        el('div', { class: 'vt-preco' },
          s.preco_cheio_centavos ? el('span', { class: 'vt-de' }, 'de ', el('s', {}, dinheiro(s.preco_cheio_centavos)), ' por') : null,
          el('strong', {}, dinheiro(s.preco_centavos), SUFIXO[s.unidade] ? el('small', {}, SUFIXO[s.unidade]) : null)),
        s.oferta_ate ? el('p', { class: 'vt-validade' }, `Oferta válida até ${dataCurta(s.oferta_ate)}`) : null),
      el('div', { class: 'vt-destaque-produto' },
        el('div', { class: 'vt-pedestal', 'aria-hidden': 'true' }),
        el('div', { class: 'vt-foto' }, s.foto
          ? el('img', { src: `${RAIZ}/fotos/${s.foto}`, alt: '' })
          : el('div', { class: 'vt-sem-foto', style: `--cor: ${s.categoria_cor || '#27E3B6'}` }, iniciais(s.nome)))),
      el('span', { class: 'vt-assinatura' }, nome));
  }

  const quadroImagem = (s) => el('article', { class: 'vt-quadro vt-midia' },
    el('img', { src: `${RAIZ}/vitrine-midia/${s.arquivo}`, alt: s.titulo || '' }));

  function quadroVideo(s, decorridoMs) {
    const video = el('video', { src: `${RAIZ}/vitrine-midia/${s.arquivo}`, muted: true, playsinline: true, preload: 'auto', 'aria-label': s.titulo || 'Vídeo' });
    video.muted = true; // o navegador só deixa tocar sozinho sem som
    video.addEventListener('loadedmetadata', () => {
      if (decorridoMs > 500 && video.duration) video.currentTime = Math.min(decorridoMs / 1000, video.duration - 0.2);
      video.play().catch(() => {});
    }, { once: true });
    // Sem sincronismo, o vídeo manda: troca quando termina. Com erro, pula.
    video.addEventListener('ended', () => { if (!sincronizar() && !pausada) avancar(1); });
    video.addEventListener('error', () => { if (!pausada) avancar(1); });
    return el('article', { class: 'vt-quadro vt-midia' }, video);
  }

  const quadroVazio = () => el('article', { class: 'vt-quadro vt-vazio' },
    el('img', { src: `${RAIZ}/img/binho-logo.png`, alt: 'Mercado Binho' }),
    el('p', {}, 'Seu mercado, pertinho de você.'));

  /** Baixa a imagem do próximo quadro enquanto este está no ar, para a troca não piscar. */
  function adiantar(s) {
    if (s?.tipo === 'produto' && s.foto) new Image().src = `${RAIZ}/fotos/${s.foto}`;
    if (s?.tipo === 'imagem') new Image().src = `${RAIZ}/vitrine-midia/${s.arquivo}`;
  }

  /* ---------- troca com esmaecimento ---------- */
  function mostrar(indice, decorridoMs = 0) {
    const s = lista[indice];
    const novo = !s ? quadroVazio() : s.tipo === 'produto' ? quadroProduto(s) : s.tipo === 'imagem' ? quadroImagem(s) : quadroVideo(s, decorridoMs);
    const anterior = quadroAtual;
    palco.append(novo);
    requestAnimationFrame(() => requestAnimationFrame(() => novo.classList.add('ativo')));
    if (anterior) {
      anterior.classList.remove('ativo');
      anterior.querySelector('video')?.pause();
      setTimeout(() => anterior.remove(), FADE_MS + 50);
    }
    quadroAtual = novo;
    atual = indice;
    adiantar(lista[(indice + 1) % Math.max(lista.length, 1)]);
    aoMudar?.({ atual, total: lista.length, pausada });
  }

  async function recarregarNaVolta() {
    if (buscando) return;
    buscando = true;
    const mudou = await carregar();
    buscando = false;
    if (mudou && ligada && !pausada) {
      if (sincronizar()) { const { indice, decorrido } = pelaHora(); mostrar(indice, decorrido); } else mostrar(0);
      proximaTroca = Date.now() + (agenda[atual]?.dur ?? 12000);
    }
  }

  function avancar(delta) {
    if (!lista.length) return mostrar(-1);
    const indice = ((atual + delta) % lista.length + lista.length) % lista.length;
    mostrar(indice);
    proximaTroca = Date.now() + agenda[indice].dur;
    return undefined;
  }

  /** Confere 5 vezes por segundo se é hora de trocar. */
  function batida() {
    if (!ligada || pausada) return;
    // A cada volta completa (no mínimo a cada 30 s) confere se a administração mudou algo.
    if (Date.now() - ultimaBusca > Math.max(total, 30_000)) recarregarNaVolta();
    if (!lista.length) { if (atual !== -1 || !quadroAtual) mostrar(-1); return; }
    if (sincronizar()) {
      const { indice, decorrido } = pelaHora();
      if (indice !== atual) mostrar(indice, decorrido);
    } else if (Date.now() >= proximaTroca && lista[atual]?.tipo !== 'video') {
      avancar(1);
    }
  }

  function retomar() {
    pausada = false;
    if (sincronizar()) { const { indice, decorrido } = pelaHora(); if (indice !== atual) mostrar(indice, decorrido); }
    else proximaTroca = Date.now() + (agenda[atual]?.dur ?? 12000);
    quadroAtual?.querySelector('video')?.play().catch(() => {});
    aoMudar?.({ atual, total: lista.length, pausada });
  }

  return {
    elemento,
    get dados() { return dados; },
    get pausada() { return pausada; },
    carregar,
    async iniciar() {
      if (ligada) return;
      ligada = true;
      pausada = false;
      if (!dados) await carregar();
      if (!ligada) return;
      if (sincronizar() && lista.length) { const { indice, decorrido } = pelaHora(); mostrar(indice, decorrido); }
      else mostrar(lista.length ? 0 : -1);
      proximaTroca = Date.now() + (agenda[atual]?.dur ?? 12000);
      relogio = setInterval(batida, 200);
    },
    parar() {
      ligada = false;
      clearInterval(relogio);
      palco.querySelectorAll('video').forEach((v) => v.pause());
      limpar(palco);
      quadroAtual = null;
      atual = -1;
    },
    /** Avançar ou voltar à mão pausa a apresentação; "retomar" volta à sequência (e ao quadro da hora). */
    proximo() { pausada = true; avancar(1); },
    anterior() { pausada = true; avancar(-1); },
    pausar() { pausada = true; quadroAtual?.querySelector('video')?.pause(); aoMudar?.({ atual, total: lista.length, pausada }); },
    retomar,
    /** Quando a aba volta a aparecer, vai direto ao quadro certo. */
    acertar() { if (ligada && !pausada) batida(); },
  };
}
