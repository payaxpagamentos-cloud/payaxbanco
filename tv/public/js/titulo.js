import { api, arte } from './api.js';
import { el, limpar, icone, toast, acao, duracao, dataBR, etiquetaIdade, modal } from './ui.js';
import { cartaz, fileira } from './cartoes.js';
import { tocar } from './player.js';

/** Página do filme ou da série: ficha, botões, temporadas, episódios e parecidos. */
export async function telaTitulo(raiz, chave, { ir, aoAtualizar }) {
  limpar(raiz, el('div', { class: 'secao' }, el('div', { class: 'cartao vazio' }, 'Carregando…')));
  const { titulo: t } = await api.get(`/tv/titulos/${encodeURIComponent(chave)}`);

  const assistir = async (alvo, rotulo) => {
    if (t.bloqueado) {
      const trocar = await modal('Conteúdo de outro plano', (fechar) => [
        el('p', { class: 'mudo' }, `"${t.nome}" faz parte do plano ${t.plano_nome}. Mude de plano para assistir.`),
        el('div', { class: 'linha fim' },
          el('button', { class: 'btn vazio', onclick: () => fechar(false) }, 'Agora não'),
          el('button', { class: 'btn primario', onclick: () => fechar(true) }, 'Ver planos')),
      ]);
      if (trocar) ir('#/conta');
      return;
    }
    await tocar({ ...alvo, aoFechar: () => aoAtualizar?.() });
    void rotulo;
    telaTitulo(raiz, chave, { ir, aoAtualizar });
  };

  const prog = t.progresso;
  const continuarEp = t.tipo === 'serie' ? (t.proximo_episodio ?? null) : null;
  const rotuloPrincipal = t.tipo === 'filme'
    ? (prog && !prog.concluido && prog.segundos > 30 ? `Continuar de ${duracao(prog.segundos)}` : 'Assistir')
    : (continuarEp ? `Assistir T${continuarEp.temporada} E${continuarEp.numero}` : 'Assistir');

  const botaoPrincipal = el('button', { class: 'btn claro grande', disabled: t.tipo === 'filme' ? !t.tem_video : !continuarEp },
    icone('tocar'), rotuloPrincipal);
  botaoPrincipal.addEventListener('click', () => acao(botaoPrincipal, () => assistir(
    t.tipo === 'filme' ? { tipo: 'filme', titulo_id: t.id } : { tipo: 'episodio', titulo_id: t.id, episodio_id: continuarEp.id },
  )));

  const botaoLista = el('button', { class: 'btn vazio grande' }, icone(t.favorito ? 'certo' : 'mais'), t.favorito ? 'Na minha lista' : 'Minha lista');
  botaoLista.addEventListener('click', () => acao(botaoLista, async () => {
    const novo = !t.favorito;
    if (novo) await api.post(`/tv/minha-lista/${t.id}`);
    else await api.del(`/tv/minha-lista/${t.id}`);
    t.favorito = novo;
    botaoLista.replaceChildren(icone(novo ? 'certo' : 'mais'), novo ? 'Na minha lista' : 'Minha lista');
    toast(novo ? 'Adicionado à sua lista.' : 'Removido da sua lista.');
    aoAtualizar?.();
  }));

  const botaoTrailer = t.trailer ? el('button', { class: 'btn vazio grande' }, icone('tocar'), 'Trailer') : null;
  botaoTrailer?.addEventListener('click', () => acao(botaoTrailer, () => tocar({ tipo: 'trailer', titulo_id: t.id })));

  const episodioEl = (ep, temporadaNumero) => {
    const b = el('button', { class: 'episodio', disabled: !ep.tem_video },
      el('div', { class: 'thumb' }, arte(ep.thumb) ? el('img', { src: arte(ep.thumb), alt: '', loading: 'lazy' }) : el('span', { class: 'n' }, ep.numero)),
      el('div', { class: 'meio' },
        el('div', { class: 'linha entre' },
          el('strong', {}, `${ep.numero}. ${ep.nome}`),
          el('span', { class: 'pequeno mudo' }, duracao(ep.duracao_s))),
        ep.sinopse ? el('p', { class: 'pequeno mudo duas-linhas', style: 'margin:4px 0 0' }, ep.sinopse) : null,
        el('div', { class: 'linha', style: 'margin-top:6px;gap:6px' },
          ep.concluido ? el('span', { class: 'etiqueta ok' }, 'assistido') : null,
          !ep.tem_video ? el('span', { class: 'etiqueta aviso' }, 'em breve') : null,
          ep.visto_segundos && !ep.concluido ? el('span', { class: 'etiqueta info' }, `parou em ${duracao(ep.visto_segundos)}`) : null),
        ep.visto_segundos && ep.duracao_s
          ? el('div', { class: 'barra-progresso', style: 'margin-top:7px' }, el('span', { style: `width:${Math.min(100, (ep.visto_segundos / ep.duracao_s) * 100)}%` }))
          : null));
    b.addEventListener('click', () => assistir({ tipo: 'episodio', titulo_id: t.id, episodio_id: ep.id }));
    void temporadaNumero;
    return b;
  };

  const corpo = el('div', { class: 'secao' });
  const desenharCorpo = () => {
    if (t.tipo === 'serie' && t.temporadas.length) {
      let aberta = t.temporadas.find((tm) => tm.episodios.some((e) => e.id === continuarEp?.id)) ?? t.temporadas[0];
      const lista = el('div', { class: 'coluna' });
      const abas = el('div', { class: 'abas' });
      const pintar = () => {
        limpar(abas, t.temporadas.map((tm) => el('button', {
          class: tm.id === aberta.id ? 'on' : '',
          onclick: () => { aberta = tm; pintar(); },
        }, tm.nome ?? `Temporada ${tm.numero}`, el('span', { class: 'mini apagado' }, ` ${tm.episodios.length}`))));
        limpar(lista, aberta.episodios.length
          ? aberta.episodios.map((ep) => episodioEl(ep, aberta.numero))
          : el('div', { class: 'cartao vazio' }, 'Os episódios desta temporada ainda não foram publicados.'));
      };
      pintar();
      limpar(corpo, el('h2', {}, 'Episódios'), abas, lista);
    } else {
      limpar(corpo,
        el('h2', {}, 'Sobre'),
        el('div', { class: 'cartao ficha-tecnica' },
          el('div', {}, el('span', {}, 'Gêneros'), t.generos ?? '—'),
          el('div', {}, el('span', {}, 'Direção'), t.direcao ?? '—'),
          el('div', {}, el('span', {}, 'Elenco'), t.elenco ?? '—'),
          el('div', {}, el('span', {}, 'País e ano'), [t.pais, t.ano].filter(Boolean).join(' · ') || '—'),
          t.estreia ? el('div', {}, el('span', {}, 'Estreia'), dataBR(t.estreia)) : null));
    }
  };
  desenharCorpo();

  const banner = arte(t.banner ?? t.capa);
  limpar(raiz,
    el('section', { class: 'titulo-topo' },
      el('div', { class: 'arte' }, banner ? el('img', { src: banner, alt: '' }) : null),
      el('div', { class: 'corpo' },
        arte(t.capa) ? el('div', { class: 'poster' }, el('img', { src: arte(t.capa), alt: t.nome })) : null,
        el('div', { class: 'ficha' },
          el('div', { class: 'linha', style: 'gap:7px;margin-bottom:8px' },
            t.original ? el('span', { class: 'etiqueta ok' }, 'ORIGINAL PAYAX') : null,
            el('span', { class: 'etiqueta' }, t.tipo === 'filme' ? 'Filme' : 'Série'),
            t.bloqueado ? el('span', { class: 'etiqueta plano' }, t.plano_nome) : null),
          el('h1', {}, t.nome),
          el('div', { class: 'linha', style: 'gap:9px;margin-bottom:12px' },
            etiquetaIdade(t.classificacao),
            el('span', { class: 'pequeno mudo' }, [t.ano, t.tipo === 'filme' ? duracao(t.duracao_s) : `${t.temporadas.length} temporada${t.temporadas.length > 1 ? 's' : ''}`,
              t.generos].filter(Boolean).join('  ·  '))),
          t.sinopse ? el('p', { class: 'mudo tres-linhas', style: 'max-width:62ch' }, t.sinopse) : null,
          el('div', { class: 'linha', style: 'margin-top:16px' }, botaoPrincipal, botaoLista, botaoTrailer)))),
    corpo,
    t.similares?.length ? fileira('Parecidos com este', t.similares.map((s) => cartaz(s, { aoAbrir: (x) => ir(`#/titulo/${x.slug}`) }))) : null);
}
