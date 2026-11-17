import { arte } from './api.js';
import { el, icone, duracao, etiquetaIdade, limpar, hora } from './ui.js';

/** Cartaz do título (em pé, como nas prateleiras) ou deitado (continuar assistindo). */
export function cartaz(item, { deitado = false, aoAbrir, aoTocar } = {}) {
  const imagem = deitado ? (item.banner ?? item.capa) : (item.capa ?? item.banner);
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

  const b = el('button', { class: `cartaz${deitado ? ' deitado' : ''}${item.bloqueado ? ' bloqueado' : ''}`, title: item.nome },
    capa,
    el('div', { class: 'nome cortar' }, item.nome),
    el('div', { class: 'meta linha firme', style: 'gap:6px' }, etiquetaIdade(item.classificacao), el('span', { class: 'cortar' }, legenda)));
  b.addEventListener('click', (e) => {
    // Só o botão redondo toca na hora; clicar no resto do cartaz abre a página do título.
    if (aoTocar && e.target.closest('.tocar span')) return aoTocar(item);
    return aoAbrir?.(item);
  });
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
      el('div', { class: 'pequeno cortar', style: 'margin-top:2px' }, canal.agora?.titulo ?? 'Programação ao vivo'),
      canal.agora?.andamento !== null && canal.agora?.andamento !== undefined
        ? el('div', { class: 'barra-progresso vivo', style: 'margin-top:6px' }, el('span', { style: `width:${canal.agora.andamento}%` }))
        : null,
      canal.depois ? el('div', { class: 'mini apagado', style: 'margin-top:4px' }, `depois · ${hora(canal.depois.inicio)} ${canal.depois.titulo}`) : null),
    canal.bloqueado ? el('span', { class: 'etiqueta plano' }, canal.plano_nome ?? 'Plano') : null);
  b.addEventListener('click', () => aoAbrir?.(canal));
  return b;
}

/** Fileira com rolagem lateral e setas (as "prateleiras" da home). */
export function fileira(nome, itens, { larga = false, verTudo = null } = {}) {
  const trilha = el('div', { class: `trilha${larga ? ' larga' : ''}` }, itens);
  const rolar = (dir) => trilha.scrollBy({ left: dir * Math.max(240, trilha.clientWidth * 0.85), behavior: 'smooth' });
  return el('section', { class: 'fileira' },
    el('header', {},
      el('h2', {}, nome),
      el('div', { class: 'linha', style: 'gap:4px' },
        verTudo ? el('button', { class: 'ver-tudo', onclick: verTudo }, 'Ver tudo') : null,
        el('button', { class: 'btn redondo vazio pequeno', 'aria-label': 'Anterior', onclick: () => rolar(-1), style: 'transform:rotate(90deg)' }, icone('seta')),
        el('button', { class: 'btn redondo vazio pequeno', 'aria-label': 'Próximos', onclick: () => rolar(1), style: 'transform:rotate(-90deg)' }, icone('seta')))),
    trilha);
}

/** Grade de cartazes (telas "Filmes", "Séries", busca e minha lista). */
export const grade = (itens) => el('div', { class: 'grade' }, itens);

export const vazio = (texto, acaoEl = null) => el('div', { class: 'cartao vazio' }, el('p', { style: 'margin:0 0 10px' }, texto), acaoEl);

export const carregando = () => limpar(el('div', { class: 'secao' }), el('div', { class: 'cartao vazio' }, 'Carregando…'));
