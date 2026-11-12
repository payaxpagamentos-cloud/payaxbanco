import { el, limpar, dinheiro, iniciais, RAIZ } from '../js/ui.js';

/**
 * Vitrine: produtos, ofertas, vídeos e imagens passando sozinhos.
 * O mesmo módulo roda na TV da loja (página /vitrine/) e no tablet do caixa quando ninguém está comprando.
 *
 * A sequência vem pronta do servidor (api/vitrine). No fim de cada volta ela é buscada de novo, então
 * oferta nova, vídeo novo ou mudança de preço aparecem sem precisar recarregar a TV.
 */
const SUFIXO = { kg: '/kg', l: '/litro' };
const dataCurta = (iso) => (iso ? iso.split('-').reverse().slice(0, 2).join('/') : '');
const SEGUNDOS_TELA_VAZIA = 20;

export function criarVitrine({ modo = 'tv' } = {}) {
  const palco = el('div', { class: 'vt-palco' });
  const progresso = el('span');
  const logo = el('img', { class: 'vt-logo', src: `${RAIZ}/img/binho-logo.png`, alt: 'Mercado Binho' });
  const condominio = el('span', { class: 'vt-condominio' });
  const chamada = modo === 'tablet'
    ? el('span', { class: 'vt-chamada' }, el('i', { class: 'vt-pulso' }), 'Toque na tela ou passe um produto no leitor para começar')
    : el('span', { class: 'vt-chamada' }, 'Compre sozinho no autoatendimento do balcão');
  const elemento = el('div', { class: `vitrine vt-${modo}` },
    palco,
    el('div', { class: 'vt-progresso' }, progresso),
    el('footer', { class: 'vt-rodape' }, el('div', { class: 'vt-marca' }, logo, condominio), chamada));

  let lista = [];
  let posicao = -1;
  let tempo = null;
  let video = null;
  let ligada = false;
  let dados = null;

  async function carregar() {
    try {
      const r = await fetch(`${RAIZ}/api/vitrine`, { cache: 'no-store' });
      if (!r.ok) return; // mantém a sequência anterior: a TV não pode apagar porque o servidor piscou
      dados = await r.json();
      lista = dados.slides ?? [];
      logo.alt = dados.mercado?.nome || 'Mercado Binho';
      condominio.textContent = dados.mercado?.condominio || '';
    } catch { /* sem rede: segue com o que já tinha */ }
  }

  /* ---------- um quadro de cada tipo ---------- */
  const quadroProduto = (s) => el('article', { class: `vt-quadro vt-produto vt-${s.destaque}` },
    el('div', { class: 'vt-foto' }, s.foto
      ? el('img', { src: `${RAIZ}/fotos/${s.foto}`, alt: '' })
      : el('div', { class: 'vt-sem-foto', style: `--cor: ${s.categoria_cor || '#27E3B6'}` }, iniciais(s.nome))),
    el('div', { class: 'vt-info' },
      el('span', { class: 'vt-selo' }, s.selo),
      el('h2', { class: 'vt-nome' }, s.nome),
      s.categoria ? el('p', { class: 'vt-categoria' }, s.categoria) : null,
      el('div', { class: 'vt-preco' },
        s.preco_cheio_centavos ? el('span', { class: 'vt-de' }, 'de ', el('s', {}, dinheiro(s.preco_cheio_centavos)), ' por') : null,
        el('strong', {}, dinheiro(s.preco_centavos), SUFIXO[s.unidade] ? el('small', {}, SUFIXO[s.unidade]) : null)),
      s.oferta_ate ? el('p', { class: 'vt-validade' }, `Oferta válida até ${dataCurta(s.oferta_ate)}`) : null));

  const quadroImagem = (s) => el('article', { class: 'vt-quadro vt-midia' },
    el('img', { src: `${RAIZ}/vitrine-midia/${s.arquivo}`, alt: s.titulo || '' }));

  function quadroVideo(s) {
    video = el('video', { src: `${RAIZ}/vitrine-midia/${s.arquivo}`, muted: true, playsinline: true, autoplay: true, preload: 'auto' });
    video.muted = true; // o navegador só deixa tocar sozinho sem som
    video.addEventListener('ended', avancar);
    video.addEventListener('error', avancar);
    video.addEventListener('timeupdate', () => {
      if (video?.duration) progresso.style.transform = `scaleX(${video.currentTime / video.duration})`;
    });
    return el('article', { class: 'vt-quadro vt-midia' }, video);
  }

  const quadroVazio = () => el('article', { class: 'vt-quadro vt-vazio' },
    el('img', { src: `${RAIZ}/img/binho-logo.png`, alt: '' }),
    el('p', {}, 'Bem-vindo! Passe os produtos e pague sozinho, no seu tempo.'));

  /* ---------- troca de quadro ---------- */
  function mostrar(quadro, segundos) {
    const anterior = palco.lastElementChild;
    palco.append(quadro);
    if (anterior) {
      anterior.classList.add('saindo');
      setTimeout(() => anterior.remove(), 700);
    }
    progresso.style.transition = 'none';
    progresso.style.transform = 'scaleX(0)';
    if (segundos) {
      progresso.getBoundingClientRect(); // força o navegador a aplicar o zero antes de animar
      progresso.style.transition = `transform ${segundos}s linear`;
      progresso.style.transform = 'scaleX(1)';
      tempo = setTimeout(avancar, segundos * 1000);
    }
  }

  /** Baixa a foto do próximo quadro enquanto este está na tela, para a troca não piscar. */
  function adiantar(s) {
    if (s?.tipo === 'produto' && s.foto) new Image().src = `${RAIZ}/fotos/${s.foto}`;
    if (s?.tipo === 'imagem') new Image().src = `${RAIZ}/vitrine-midia/${s.arquivo}`;
  }

  async function avancar() {
    if (!ligada) return;
    clearTimeout(tempo);
    if (video) { video.pause(); video = null; }
    posicao += 1;
    if (posicao >= lista.length) {
      await carregar(); // fim da volta: busca a sequência de novo
      if (!ligada) return;
      posicao = 0;
    }
    const s = lista[posicao];
    if (!s) return mostrar(quadroVazio(), SEGUNDOS_TELA_VAZIA);
    adiantar(lista[posicao + 1] ?? lista[0]);
    if (s.tipo === 'produto') return mostrar(quadroProduto(s), dados?.segundos_produto || 8);
    if (s.tipo === 'imagem') return mostrar(quadroImagem(s), s.duracao_seg || 10);
    // Vídeo: avança quando termina; o limite é só uma rede de segurança se ele travar.
    mostrar(quadroVideo(s), 0);
    tempo = setTimeout(avancar, (s.duracao_seg || 180) * 1000);
    return undefined;
  }

  return {
    elemento,
    get dados() { return dados; },
    async iniciar() {
      if (ligada) return;
      ligada = true;
      posicao = -1;
      if (!dados) await carregar();
      avancar();
    },
    parar() {
      ligada = false;
      clearTimeout(tempo);
      if (video) { video.pause(); video = null; }
      limpar(palco);
    },
    carregar,
  };
}
