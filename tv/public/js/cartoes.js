import { arte } from './api.js';
import { el, icone, duracao, etiquetaIdade, limpar, hora } from './ui.js';
import { ehTV } from './tv.js';

/**
 * Peças da vitrine: cartão do título (deitado, como nas prateleiras das grandes plataformas),
 * cartão de canal, fileira com rolagem lateral e a prévia que cresce quando o ponteiro para
 * sobre um cartão.
 */

const PONTEIRO_FINO = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// ---------------------------------------------------------------- prévia que cresce

let timerPrevia = null;
let previaAberta = null;

function fecharPrevia() {
  clearTimeout(timerPrevia);
  previaAberta?.remove();
  previaAberta = null;
}

/** A prévia aparece sobre a fileira, maior que o cartão, com os botões de ação. */
function abrirPrevia(origem, item, { aoAbrir, aoTocar, aoAlternarLista }) {
  fecharPrevia();
  const r = origem.getBoundingClientRect();
  const largura = Math.min(Math.max(r.width * 1.45, 300), 420);
  const esquerda = Math.min(Math.max(8, r.left + r.width / 2 - largura / 2), window.innerWidth - largura - 8);
  const topo = Math.max(8, r.top - r.height * 0.22);

  const imagem = arte(item.banner ?? item.capa);
  const caixa = el('div', { class: 'previa', style: `left:${esquerda}px;top:${topo}px;width:${largura}px` },
    el('div', { class: 'arte-previa' },
      imagem ? el('img', { src: imagem, alt: '' }) : el('div', { class: 'sem-capa' }, item.nome),
      el('div', { class: 'titulo-sobre cortar' }, item.nome)),
    el('div', { class: 'corpo-previa' },
      el('div', { class: 'acoes-previa' },
        (() => {
          const b = el('button', { class: 'btn redondo claro', title: 'Assistir', 'aria-label': 'Assistir' }, icone('tocar'));
          b.addEventListener('click', (e) => { e.stopPropagation(); fecharPrevia(); aoTocar?.(item); });
          return b;
        })(),
        (() => {
          const b = el('button', { class: 'btn redondo', title: item.favorito ? 'Remover da minha lista' : 'Adicionar à minha lista' },
            icone(item.favorito ? 'certo' : 'mais'));
          b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const novo = !item.favorito;
            item.favorito = novo;
            b.replaceChildren(icone(novo ? 'certo' : 'mais'));
            await aoAlternarLista?.(item, novo);
          });
          return b;
        })(),
        el('div', { style: 'flex:1' }),
        (() => {
          const b = el('button', { class: 'btn redondo', title: 'Mais informações', 'aria-label': 'Mais informações' }, icone('seta'));
          b.addEventListener('click', (e) => { e.stopPropagation(); fecharPrevia(); aoAbrir?.(item); });
          return b;
        })()),
      el('div', { class: 'dados-previa' },
        etiquetaIdade(item.classificacao),
        item.tipo === 'serie' ? el('span', {}, `${item.episodios_n || 0} episódio(s)`) : el('span', {}, duracao(item.duracao_s)),
        item.ano ? el('span', {}, item.ano) : null,
        item.original ? el('span', { class: 'etiqueta ok' }, 'ORIGINAL') : null,
        item.bloqueado ? el('span', { class: 'etiqueta plano' }, item.plano_nome ?? 'Plano superior') : null),
      item.generos ? el('div', { class: 'generos-previa cortar' }, item.generos) : null));

  caixa.addEventListener('click', () => { fecharPrevia(); aoAbrir?.(item); });
  caixa.addEventListener('mouseleave', fecharPrevia);
  document.body.append(caixa);
  previaAberta = caixa;
}

window.addEventListener('scroll', fecharPrevia, { passive: true });
window.addEventListener('resize', fecharPrevia);

/** Cartão do título. Deitado (16:9) por padrão; em pé nas fileiras de cartazes e no Top 10. */
export function cartaz(item, { retrato = false, posicao = null, aoAbrir, aoTocar, aoAlternarLista } = {}) {
  const emPe = retrato || posicao !== null;
  const imagem = emPe ? (item.capa ?? item.banner) : (item.banner ?? item.capa);
  const url = arte(imagem);

  const capa = el('div', { class: 'capa' },
    url ? el('img', { src: url, alt: item.nome, loading: 'lazy' }) : el('div', { class: 'sem-capa' }, item.nome),
    el('div', { class: 'selos' },
      item.original ? el('span', { class: 'etiqueta ok' }, 'ORIGINAL') : null,
      item.bloqueado ? el('span', { class: 'etiqueta plano' }, item.plano_nome ?? 'Plano superior') : null),
    el('div', { class: 'tocar' }, el('span', {}, icone('tocar'))),
    item.retomar?.percentual ? el('div', { class: 'andamento' }, el('div', { class: 'barra-progresso' }, el('span', { style: `width:${item.retomar.percentual}%` }))) : null);

  const legenda = item.retomar?.episodio
    ? `T${item.retomar.episodio.temporada} E${item.retomar.episodio.numero} · falta ${duracao(Math.max(0, (item.retomar.duracao_s || 0) - item.retomar.segundos))}`
    : [item.ano, item.tipo === 'serie' ? `${item.episodios_n || 0} ep.` : duracao(item.duracao_s)].filter(Boolean).join(' · ');

  const b = el('button', {
    class: `cartaz${emPe ? ' retrato' : ' deitado'}${posicao !== null ? ' top10' : ''}${item.bloqueado ? ' bloqueado' : ''}`,
    title: item.nome,
  },
  posicao !== null ? el('div', { class: 'numero' }, String(posicao)) : null,
  capa,
  el('div', { class: 'nome cortar' }, item.nome),
  el('div', { class: 'meta linha firme', style: 'gap:6px' }, etiquetaIdade(item.classificacao), el('span', { class: 'cortar' }, legenda)));

  b.addEventListener('click', (e) => {
    // O botão redondo toca na hora; o resto do cartão abre a janela do título.
    if (aoTocar && e.target.closest('.tocar span')) return aoTocar(item);
    return aoAbrir?.(item);
  });

  // A prévia é coisa de computador: na TV quem manda é o foco, no celular não há ponteiro.
  if (!ehTV && PONTEIRO_FINO()) {
    b.addEventListener('mouseenter', () => {
      clearTimeout(timerPrevia);
      timerPrevia = setTimeout(() => abrirPrevia(b, item, { aoAbrir, aoTocar, aoAlternarLista }), 500);
    });
    b.addEventListener('mouseleave', (e) => {
      clearTimeout(timerPrevia);
      // Se o ponteiro foi para dentro da própria prévia, ela continua aberta.
      if (!previaAberta || !previaAberta.contains(e.relatedTarget)) setTimeout(() => {
        if (previaAberta && !previaAberta.matches(':hover')) fecharPrevia();
      }, 120);
    });
  }
  return b;
}

/** Cartão do canal ao vivo, com o que está no ar agora. */
export function canalCartao(canal, { aoAbrir } = {}) {
  const logo = arte(canal.logo);
  const b = el('button', { class: 'canal-cartao' },
    el('div', { class: 'logo' }, logo ? el('img', { src: logo, alt: canal.nome, loading: 'lazy' }) : String(canal.numero)),
    el('div', { class: 'meio' },
      el('div', { class: 'linha firme', style: 'gap:6px' },
        el('span', { class: 'num' }, canal.numero),
        el('strong', { class: 'cortar' }, canal.nome),
        canal.sinal_status === 'falha' ? el('span', { class: 'etiqueta erro' }, 'fora do ar') : el('span', { class: 'etiqueta vivo' }, 'AO VIVO')),
      el('div', { class: 'pequeno cortar', style: 'margin-top:3px' }, canal.agora?.titulo ?? 'Programação ao vivo'),
      canal.agora?.andamento !== null && canal.agora?.andamento !== undefined
        ? el('div', { class: 'barra-progresso vivo', style: 'margin-top:7px' }, el('span', { style: `width:${canal.agora.andamento}%` }))
        : null,
      canal.depois ? el('div', { class: 'mini apagado', style: 'margin-top:5px' }, `depois · ${hora(canal.depois.inicio)} ${canal.depois.titulo}`) : null),
    canal.bloqueado ? el('span', { class: 'etiqueta plano' }, canal.plano_nome ?? 'Plano') : null);
  b.addEventListener('click', () => aoAbrir?.(canal));
  return b;
}

/** Fileira com rolagem lateral e setas nas pontas. */
export function fileira(nome, itens, { larga = false, cartazes = false, verTudo = null } = {}) {
  const trilha = el('div', { class: `trilha${larga ? ' larga' : ''}${cartazes ? ' cartazes' : ''}` }, itens);
  const rolar = (dir) => trilha.scrollBy({ left: dir * Math.max(260, trilha.clientWidth * 0.88), behavior: 'smooth' });
  return el('section', { class: 'fileira' },
    el('header', {},
      el('h2', {}, nome),
      el('div', { class: 'linha', style: 'gap:4px' },
        verTudo ? el('button', { class: 'ver-tudo', onclick: verTudo }, 'Ver tudo ›') : null,
        el('button', { class: 'btn redondo pequeno', 'aria-label': 'Anterior', onclick: () => rolar(-1), style: 'transform:rotate(90deg)' }, icone('seta')),
        el('button', { class: 'btn redondo pequeno', 'aria-label': 'Próximos', onclick: () => rolar(1), style: 'transform:rotate(-90deg)' }, icone('seta')))),
    trilha);
}

/** Grade de cartazes (telas "Filmes", "Séries", busca e minha lista). */
export const grade = (itens) => el('div', { class: 'grade' }, itens);

export const vazio = (texto, acaoEl = null) => el('div', { class: 'cartao vazio' }, el('p', { style: 'margin:0 0 10px' }, texto), acaoEl);

export const carregando = () => limpar(el('div', { class: 'secao' }), el('div', { class: 'cartao vazio' }, 'Carregando…'));

export { fecharPrevia };
