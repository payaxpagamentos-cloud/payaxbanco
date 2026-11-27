import { api, sessao, perfil as perfilGuardado, arte } from './api.js';
import { el, $, limpar, icone, toast, acao, marca, iniciais, corPerfil, etiquetaIdade, atrasar, repetir, hora, diaSemana,
  hojeLocal, somarDias, duracao, modal, CATEGORIAS_CANAL, ORDEM_CATEGORIAS } from './ui.js';
import { telaEntrada, telaPlanos, telaPagamento } from './entrada.js';
import { urlMascote } from './mascotes.js';
import { telaPerfis } from './perfis.js';
import { telaTitulo, modalTitulo } from './titulo.js';
import { telaConta } from './conta.js';
import { cartaz, canalCartao, fileira, grade, vazio, fecharPrevia } from './cartoes.js';
import { tocar } from './player.js';
import { ehTV, ligarControle, focarPrimeiro } from './tv.js';
import { registrarServiceWorker, botaoInstalar, convidarUmaVez } from './instalar.js';

const raiz = $('#app');
let conta = null;
let pararTela = null;

const ir = (hash) => {
  if (window.location.hash === hash) desenharRota();
  else window.location.hash = hash;
};

window.addEventListener('tv:sair', () => { sessao.limpar(); iniciar(); });
window.addEventListener('tv:assinatura', () => { if (!window.location.hash.startsWith('#/planos')) ir('#/planos'); });
window.addEventListener('tv:pin', () => { perfilGuardado.limpar(); ir('#/perfis'); });
window.addEventListener('hashchange', () => desenharRota());

// Controle remoto da Smart TV: Voltar fecha o que estiver aberto e, na tela inicial, sai do app.
ligarControle({
  aoVoltar: () => {
    if (window.playtechvipPlayer) { window.playtechvipPlayer.fechar(); return true; }
    if (window.playtechvipModal) { window.playtechvipModal(null); return true; }
    if ((window.location.hash || '#/') !== '#/') { ir('#/'); return true; }
    return false;
  },
  aoMidia: (comando) => window.playtechvipPlayer?.[comando]?.(),
});

// ---------------------------------------------------------------- entrada

async function iniciar() {
  pararTela?.();
  pararTela = null;
  if (!sessao.get()?.token) {
    telaEntrada(raiz, { aoEntrar: () => iniciar() });
    focarPrimeiro(raiz);
    return;
  }
  try {
    conta = await api.get('/conta');
  } catch (err) {
    if (err.status === 401) return;
    limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'caixa' }, marca(),
      el('div', { class: 'aviso erro', style: 'margin-top:16px' }, err.message),
      el('button', { class: 'btn primario bloco', style: 'margin-top:14px', onclick: () => iniciar() }, 'Tentar de novo'))));
    return;
  }
  if (conta.usuario.perfil !== 'assinante') {
    // A operação entra pelo painel; aqui ela assiste para conferir o sinal.
    if (!conta.perfis.length) {
      await api.post('/conta/perfis', { nome: 'Operação', classificacao_max: 18 });
      conta = await api.get('/conta');
    }
  }
  if (!conta.assinatura.ativa) {
    const f = conta.assinatura.fatura_aberta;
    if (f) return telaPagamento(raiz, { fatura: f, pagamentos: conta.pagamentos, aoPagar: () => iniciar(), aoVoltar: () => ir('#/planos') });
    return telaPlanos(raiz, {
      assinatura: conta.assinatura,
      aviso: conta.assinatura.aviso,
      aoAssinar: (r) => (r.fatura
        ? telaPagamento(raiz, { fatura: r.fatura, pagamentos: conta.pagamentos, aoPagar: () => iniciar(), aoVoltar: () => iniciar() })
        : iniciar()),
    });
  }
  if (!perfilGuardado.get()?.id || !conta.perfis.some((p) => p.id === perfilGuardado.get().id)) {
    telaPerfis(raiz, { aoEscolher: () => { ir('#/'); iniciar2(); }, aoSair: () => { sessao.limpar(); iniciar(); } });
    focarPrimeiro(raiz);
    return undefined;
  }
  return iniciar2();
}

function iniciar2() {
  montarCasca();
  desenharRota();
  // Convite para instalar no celular: aparece uma vez, depois que o assinante já está dentro.
  if (!ehTV) setTimeout(convidarUmaVez, 2500);
}

// ---------------------------------------------------------------- casca (topo e navegação)

const NAV = [
  ['#/', 'Início'],
  ['#/canais', 'Canais ao vivo'],
  ['#/guia', 'Guia'],
  ['#/filmes', 'Filmes'],
  ['#/series', 'Séries'],
  ['#/lista', 'Minha lista'],
];

let conteudo = null;
let nav = null;

function montarCasca() {
  const p = perfilGuardado.get();
  const campoBusca = el('input', { type: 'search', placeholder: 'Buscar título, canal ou programa', 'aria-label': 'Buscar' });
  campoBusca.addEventListener('input', atrasar(() => {
    const q = campoBusca.value.trim();
    if (q.length >= 2) ir(`#/busca?q=${encodeURIComponent(q)}`);
    else if (window.location.hash.startsWith('#/busca')) ir('#/');
  }, 400));

  nav = el('nav', {}, NAV.map(([hash, rotulo]) => el('button', { onclick: () => ir(hash), dataset: { hash } }, rotulo)));

  // O mascote do perfil também na barra do topo: é o mesmo rosto que a pessoa escolheu.
  const avatar = p?.avatar
    ? el('button', { class: 'avatar com-foto', title: p.nome ?? 'Perfil' }, el('img', { src: urlMascote(p.avatar), alt: '' }))
    : el('button', { class: 'avatar', style: `background:${corPerfil(p?.nome, p?.cor)}`, title: p?.nome ?? 'Perfil' }, iniciais(p?.nome));
  avatar.addEventListener('click', () => modal('Sua conta', (fechar) => [
    el('div', { class: 'linha', style: 'gap:12px;margin-bottom:14px' },
      el('span', { class: 'avatar g', style: `background:${corPerfil(p?.nome, p?.cor)}` }, iniciais(p?.nome)),
      el('div', {}, el('strong', {}, p?.nome), el('div', { class: 'pequeno mudo' }, conta.usuario.email),
        el('div', { class: 'pequeno mudo' }, `Plano ${conta.assinatura.plano?.nome ?? '—'}`))),
    el('div', { class: 'coluna' },
      el('button', { class: 'btn bloco vazio', onclick: () => { fechar(); perfilGuardado.limpar(); iniciar(); } }, 'Trocar de perfil'),
      el('button', { class: 'btn bloco vazio', onclick: () => { fechar(); ir('#/conta'); } }, 'Minha conta e assinatura'),
      botaoInstalar(fechar),
      conta.usuario.perfil !== 'assinante'
        ? el('a', { class: 'btn bloco vazio', href: './admin/' }, 'Painel da operação')
        : null,
      el('button', { class: 'btn bloco perigo', onclick: () => { fechar(); sessao.limpar(); iniciar(); } }, 'Sair da conta')),
  ]));

  const topo = el('header', { class: 'topo' },
    el('button', { class: 'btn vazio', style: 'border:0;padding:0;background:none', onclick: () => ir('#/') }, marca()),
    nav,
    el('div', { class: 'espaco' }),
    el('div', { class: 'acoes' },
      el('div', { class: 'busca-topo' }, icone('busca'), campoBusca),
      avatar));

  conteudo = el('main', { class: 'conteudo' });
  limpar(raiz, topo, conteudo);
  const marcarTopo = () => topo.classList.toggle('solto', window.scrollY < 40);
  marcarTopo();
  window.addEventListener('scroll', marcarTopo, { passive: true });
}

function marcarNav(hash) {
  for (const b of nav?.children ?? []) b.classList.toggle('on', b.dataset.hash === hash);
}

// ---------------------------------------------------------------- rotas

function rotaAtual() {
  const bruto = window.location.hash || '#/';
  const [caminho, consulta] = bruto.split('?');
  return { caminho, params: new URLSearchParams(consulta ?? '') };
}

async function desenharRota() {
  if (!conteudo) return;
  pararTela?.();
  pararTela = null;
  const { caminho, params } = rotaAtual();
  marcarNav(caminho);
  window.scrollTo({ top: 0 });
  const recarregar = () => desenharRota();
  try {
    if (caminho === '#/' || caminho === '') await telaHome();
    else if (caminho === '#/canais') await telaCanais();
    else if (caminho === '#/guia') await telaGuia(params.get('dia'));
    else if (caminho === '#/filmes') await telaCatalogo('filme', 'Filmes', params);
    else if (caminho === '#/series') await telaCatalogo('serie', 'Séries', params);
    else if (caminho === '#/lista') await telaMinhaLista();
    else if (caminho === '#/busca') await telaBusca(params.get('q'));
    else if (caminho.startsWith('#/titulo/')) await telaTitulo(conteudo, decodeURIComponent(caminho.slice('#/titulo/'.length)), { ir, aoAtualizar: () => {} });
    else if (caminho === '#/conta') await telaConta(conteudo, { ir, aoMudar: () => iniciar() });
    else if (caminho === '#/planos') {
      telaPlanos(conteudo, {
        assinatura: conta.assinatura,
        titulo: 'Planos',
        aoVoltar: () => ir('#/conta'),
        aoAssinar: async (r) => {
          toast(r.aviso ?? 'Plano atualizado!');
          if (r.fatura) telaPagamento(raiz, { fatura: r.fatura, pagamentos: conta.pagamentos, aoPagar: () => iniciar(), aoVoltar: () => iniciar() });
          else { conta = await api.get('/conta'); ir('#/conta'); }
        },
      });
    } else if (caminho === '#/perfis') {
      telaPerfis(raiz, { aoEscolher: () => { montarCasca(); ir('#/'); }, aoSair: () => { sessao.limpar(); iniciar(); } });
    } else ir('#/');
    void recarregar;
    focarPrimeiro(conteudo);
  } catch (err) {
    if (err.status === 402 || err.status === 423) return;
    limpar(conteudo, el('div', { class: 'secao' }, el('div', { class: 'aviso erro' }, err.message),
      el('button', { class: 'btn', style: 'margin-top:12px', onclick: () => desenharRota() }, 'Tentar de novo')));
    focarPrimeiro(conteudo);
  }
}

/** Abre a janela do título sobre a tela atual, como nas grandes plataformas. */
const abrirTitulo = (t) => {
  fecharPrevia();
  modalTitulo(t.slug ?? t.id, { ir, aoAtualizar: () => desenharRota() }).catch((err) => toast(err.message, true));
};

/** Liga ou desliga "minha lista" direto do cartão. */
const alternarLista = async (item, ligado) => {
  try {
    if (ligado) await api.post(`/tv/minha-lista/${item.id}`);
    else await api.del(`/tv/minha-lista/${item.id}`);
    toast(ligado ? 'Adicionado à sua lista.' : 'Removido da sua lista.');
  } catch (err) {
    toast(err.message, true);
  }
};

const opcoesCartaz = () => ({ aoAbrir: abrirTitulo, aoTocar: tocarItem, aoAlternarLista: alternarLista });

/** Toca o que o cartaz pede: filme direto, série no próximo episódio, canal ao vivo. */
async function tocarItem(item) {
  if (item.bloqueado) {
    toast(`"${item.nome}" faz parte do plano ${item.plano_nome ?? 'superior'}.`, true);
    return;
  }
  if (item.tipo === 'serie') {
    abrirTitulo(item);
    return;
  }
  const alvo = item.retomar?.episodio_id
    ? { tipo: 'episodio', titulo_id: item.id, episodio_id: item.retomar.episodio_id }
    : { tipo: 'filme', titulo_id: item.id };
  await tocar({ ...alvo, aoFechar: () => desenharRota() });
}

async function tocarCanal(canal) {
  if (canal.bloqueado) {
    toast(canal.plano_nome ? `Este canal faz parte do plano ${canal.plano_nome}.` : 'Seu plano não inclui os canais ao vivo.', true);
    return;
  }
  await tocar({ tipo: 'canal', canal_id: canal.id, aoFechar: () => desenharRota() });
}

// ---------------------------------------------------------------- Início

async function telaHome() {
  limpar(conteudo, el('div', { class: 'secao' }, el('div', { class: 'cartao vazio' }, 'Carregando sua TV…')));
  const home = await api.get('/tv/home');
  const partes = [];

  if (home.destaques?.length) partes.push(heroEl(home.destaques));
  for (const f of home.fileiras) {
    if (f.tipo === 'canais') {
      partes.push(fileira(f.nome, f.itens.map((c) => canalCartao(c, { aoAbrir: tocarCanal })), { larga: true, verTudo: () => ir('#/canais') }));
    } else if (f.tipo === 'em_alta') {
      // Os dez mais assistidos ganham o numeral gigante ao lado do cartaz.
      partes.push(fileira('Top 10 de hoje na PLAY TECH VIP',
        f.itens.slice(0, 10).map((t, i) => cartaz(t, { posicao: i + 1, ...opcoesCartaz() })), { cartazes: true }));
    } else {
      partes.push(fileira(f.nome, f.itens.map((t) => cartaz(t, opcoesCartaz())),
        { larga: f.tipo === 'continuar', verTudo: f.tipo === 'minha_lista' ? () => ir('#/lista') : null }));
    }
  }
  if (!home.fileiras.length) {
    partes.push(el('div', { class: 'secao' }, vazio('A programação está sendo montada. Volte em instantes.')));
  }
  partes.push(rodape());
  limpar(conteudo, partes);
}

/** Rodapé da home. */
function rodape() {
  const link = (texto, aoClicar) => el('button', { onclick: aoClicar }, texto);
  return el('footer', { class: 'rodape-app' },
    el('div', { class: 'colunas' },
      el('div', {}, link('Canais ao vivo', () => ir('#/canais')), link('Guia de programação', () => ir('#/guia')), link('Filmes', () => ir('#/filmes'))),
      el('div', {}, link('Séries', () => ir('#/series')), link('Minha lista', () => ir('#/lista')), link('Minha conta', () => ir('#/conta'))),
      el('div', {}, link('Planos e assinatura', () => ir('#/planos')), link('Perfis de visualização', () => ir('#/perfis')),
        link('Telas em uso', () => ir('#/conta'))),
      el('div', {}, el('span', {}, `Plano ${conta?.assinatura?.plano?.nome ?? '—'}`), el('span', {}, conta?.usuario?.email ?? ''))),
    el('div', { class: 'mini' }, '© PLAY TECH VIP'));
}

/** Destaque do topo que troca sozinho. */
function heroEl(destaques) {
  let i = 0;
  const caixa = el('section', { class: 'hero' });
  const pontos = el('div', { class: 'pontos' });

  const pintar = () => {
    const d = destaques[i];
    const alvo = d.tipo === 'titulo' ? d.titulo : d.canal;
    const imagem = arte(d.arte);
    const botaoAssistir = el('button', { class: 'btn claro grande' }, icone('tocar'), d.tipo === 'canal' ? 'Assistir ao vivo' : 'Assistir');
    botaoAssistir.addEventListener('click', () => acao(botaoAssistir, () => (d.tipo === 'canal'
      ? tocarCanal({ ...d.canal, bloqueado: d.bloqueado })
      : tocarItem({ ...d.titulo, tipo: d.titulo.tipo }))));

    limpar(caixa,
      el('div', { class: 'arte' }, imagem ? el('img', { src: imagem, alt: '' }) : null),
      el('div', { class: 'texto' },
        d.chamada ? el('div', { class: 'chamada' }, d.chamada) : null,
        el('h1', {}, alvo.nome),
        el('div', { class: 'linha', style: 'gap:8px' },
          d.tipo === 'canal' ? el('span', { class: 'etiqueta vivo' }, 'AO VIVO') : null,
          etiquetaIdade(alvo.classificacao ?? 0),
          d.tipo === 'canal' && d.canal.agora ? el('span', { class: 'pequeno mudo' }, `${d.canal.agora.titulo} · até ${hora(d.canal.agora.fim)}`)
            : el('span', { class: 'pequeno mudo' }, [alvo.ano, duracao(alvo.duracao_s)].filter(Boolean).join(' · '))),
        d.descricao ? el('p', { class: 'sinopse tres-linhas' }, d.descricao) : null,
        el('div', { class: 'linha' },
          botaoAssistir,
          d.tipo === 'titulo' ? el('button', { class: 'btn grande', onclick: () => abrirTitulo(d.titulo) }, icone('info'), 'Mais informações') : null,
          d.tipo === 'canal' ? el('button', { class: 'btn vazio grande', onclick: () => ir('#/guia') }, icone('tv'), 'Ver a programação') : null)),
      destaques.length > 1 ? pontos : null);

    limpar(pontos, destaques.map((_, j) => el('button', {
      class: j === i ? 'on' : '', 'aria-label': `Destaque ${j + 1}`, onclick: () => { i = j; pintar(); },
    })));
  };
  pintar();
  if (destaques.length > 1) pararTela = repetir(() => { i = (i + 1) % destaques.length; pintar(); }, 9000);
  return caixa;
}

// ---------------------------------------------------------------- Canais ao vivo

async function telaCanais() {
  const { canais } = await api.get('/tv/canais');
  // Separado por tema. Com mais de cem canais, uma lista só vira uma parede de cartões em que
  // ninguém acha nada; por tema, a pessoa vai direto em Esportes ou Kids e pronto.
  const temas = ORDEM_CATEGORIAS.filter((c) => canais.some((x) => x.categoria === c))
    .concat([...new Set(canais.map((c) => c.categoria))].filter((c) => !ORDEM_CATEGORIAS.includes(c)));
  let filtro = 'todas';
  const corpo = el('div', { class: 'coluna', style: 'gap:26px' });
  const pilulas = el('div', { class: 'pilulas-tema' });

  const grade = (lista) => el('div', { class: 'grade', style: 'grid-template-columns:repeat(auto-fill,minmax(300px,1fr))' },
    lista.map((c) => canalCartao(c, { aoAbrir: tocarCanal })));

  const pintar = () => {
    limpar(pilulas, ['todas', ...temas].map((c) => {
      const quantos = c === 'todas' ? canais.length : canais.filter((x) => x.categoria === c).length;
      return el('button', {
        class: `btn pequeno${filtro === c ? ' primario' : ' vazio'}`,
        onclick: () => { filtro = c; pintar(); corpo.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
      }, c === 'todas' ? 'Todos' : CATEGORIAS_CANAL[c] ?? c, el('span', { class: 'conta' }, quantos));
    }));

    const mostrar = filtro === 'todas' ? temas : [filtro];
    const secoes = mostrar.map((tema) => {
      const doTema = canais.filter((c) => c.categoria === tema);
      if (!doTema.length) return null;
      return el('section', { class: 'tema' },
        el('header', { class: 'linha entre' },
          el('h2', {}, CATEGORIAS_CANAL[tema] ?? tema),
          el('span', { class: 'mudo pequeno' }, doTema.length > 1 ? `${doTema.length} canais` : '1 canal')),
        grade(doTema));
    }).filter(Boolean);
    limpar(corpo, secoes.length ? secoes : vazio('Nenhum canal neste tema.'));
  };
  pintar();

  limpar(conteudo, el('div', { class: 'secao' },
    el('div', { class: 'linha entre' },
      el('h1', {}, 'Canais ao vivo'),
      el('button', { class: 'btn pequeno', onclick: () => ir('#/guia') }, icone('tv'), 'Guia de programação')),
    pilulas, corpo));
  // O "no ar agora" muda sozinho: recarrega de 2 em 2 minutos.
  pararTela = repetir(async () => {
    const r = await api.get('/tv/canais');
    canais.splice(0, canais.length, ...r.canais);
    pintar();
  }, 120_000);
}

// ---------------------------------------------------------------- Guia (EPG)

async function telaGuia(diaPedido) {
  // Sem dia escolhido, o servidor devolve a partir de agora (independe do fuso do aparelho).
  const { canais, dia } = await api.get(diaPedido ? `/tv/guia?dia=${diaPedido}` : '/tv/guia');
  const dias = Array.from({ length: 7 }, (_, i) => somarDias(dia, i));

  const linhas = canais.map((c) => el('div', { class: 'guia-linha' },
    (() => {
      const b = el('button', { class: 'guia-canal' },
        el('div', { class: 'logo' }, arte(c.logo) ? el('img', { src: arte(c.logo), alt: '', loading: 'lazy' }) : String(c.numero)),
        el('div', { class: 'meio' }, el('strong', { class: 'cortar' }, c.nome), el('div', { class: 'mini apagado' }, `canal ${c.numero}`)));
      b.addEventListener('click', () => tocarCanal(c));
      return b;
    })(),
    el('div', { class: 'guia-programas' }, c.programas.length
      ? c.programas.map((p) => {
        const noAr = p.andamento !== null && p.andamento !== undefined;
        const b = el('button', { class: `guia-programa${noAr ? ' agora' : ''}` },
          el('div', { class: 'hora' }, `${hora(p.inicio)} – ${hora(p.fim)}${noAr ? ' · agora' : ''}`),
          el('div', { class: 'duas-linhas', style: 'font-weight:700;font-size:13.5px' }, p.titulo),
          p.classificacao ? el('div', { style: 'margin-top:5px' }, etiquetaIdade(p.classificacao)) : null,
          noAr ? el('div', { class: 'barra-progresso vivo', style: 'margin-top:6px' }, el('span', { style: `width:${p.andamento}%` })) : null);
        b.addEventListener('click', () => modal(p.titulo, (fechar) => [
          el('div', { class: 'linha', style: 'gap:8px;margin-bottom:8px' },
            el('span', { class: 'etiqueta' }, `${c.nome} · canal ${c.numero}`),
            el('span', { class: 'etiqueta info' }, `${hora(p.inicio)} – ${hora(p.fim)}`),
            etiquetaIdade(p.classificacao),
            noAr ? el('span', { class: 'etiqueta vivo' }, 'AO VIVO') : null),
          p.subtitulo ? el('p', { class: 'forte', style: 'margin:0' }, p.subtitulo) : null,
          // A descrição vem agora, não junto com a grade inteira: ela sozinha respondia por
          // 2,5 MB dos 3,1 MB do guia — texto que ninguém vê até tocar num programa.
          (() => {
            const alvo = el('p', { class: 'mudo' }, 'Carregando a descrição…');
            api.get(`/tv/programa/${p.id}`)
              .then((r) => { alvo.textContent = r.programa?.descricao || 'Sem descrição na grade.'; })
              .catch(() => { alvo.textContent = 'Sem descrição na grade.'; });
            return alvo;
          })(),
          el('div', { class: 'linha fim' },
            el('button', { class: 'btn vazio', onclick: () => fechar() }, 'Fechar'),
            noAr ? el('button', { class: 'btn primario', onclick: () => { fechar(); tocarCanal(c); } }, icone('tocar'), 'Assistir agora') : null),
        ]));
        return b;
      })
      : el('div', { class: 'cartao fundo pequeno mudo' }, 'Sem grade publicada para este dia.'))));

  limpar(conteudo, el('div', { class: 'secao' },
    el('h1', {}, 'Guia de programação'),
    el('div', { class: 'linha', style: 'margin-bottom:16px' }, dias.map((d, i) => el('button', {
      class: `btn pequeno${(i === 0 ? !diaPedido : d === diaPedido) ? ' primario' : ' vazio'}`,
      onclick: () => ir(i === 0 ? '#/guia' : `#/guia?dia=${d}`),
    }, i === 0 ? 'Hoje' : diaSemana(d)))),
    el('div', { class: 'guia' }, linhas.length ? linhas : vazio('Nenhum canal disponível.'))));
  // Cada fileira começa no programa que está no ar (ou no começo do dia, se for outro dia).
  for (const faixa of conteudo.querySelectorAll('.guia-programas')) {
    const noAr = faixa.querySelector('.guia-programa.agora');
    if (noAr) faixa.scrollLeft = Math.max(0, noAr.offsetLeft - faixa.offsetLeft - 8);
  }
}

// ---------------------------------------------------------------- Catálogo

async function telaCatalogo(tipo, titulo, params) {
  const genero = params.get('genero') ?? '';
  const ordem = params.get('ordem') ?? 'recentes';
  const [{ generos }, dados] = await Promise.all([
    api.get('/tv/generos'),
    api.get(`/tv/catalogo?tipo=${tipo}&ordem=${ordem}${genero ? `&genero=${encodeURIComponent(genero)}` : ''}&por_pagina=60`),
  ]);
  const trocar = (chave, valor) => {
    const p = new URLSearchParams({ ordem, ...(genero ? { genero } : {}) });
    if (valor) p.set(chave, valor); else p.delete(chave);
    ir(`#/${tipo === 'filme' ? 'filmes' : 'series'}?${p}`);
  };

  limpar(conteudo, el('div', { class: 'secao' },
    el('h1', {}, titulo),
    el('div', { class: 'filtros' },
      el('label', { class: 'campo' }, 'Gênero', el('select', { onchange: (e) => trocar('genero', e.target.value) },
        el('option', { value: '' }, 'Todos'),
        generos.filter((g) => g.titulos_n > 0).map((g) => el('option', { value: g.slug, ...(g.slug === genero ? { selected: true } : {}) }, `${g.nome} (${g.titulos_n})`)))),
      el('label', { class: 'campo' }, 'Ordenar por', el('select', { onchange: (e) => trocar('ordem', e.target.value) },
        [['recentes', 'Mais recentes'], ['populares', 'Mais assistidos'], ['nome', 'Nome (A–Z)'], ['ano', 'Ano']].map(([val, rot]) => el('option', {
          value: val, ...(val === ordem ? { selected: true } : {}),
        }, rot)))),
      el('div', { class: 'pequeno mudo', style: 'margin-left:auto' }, `${dados.total} ${dados.total === 1 ? 'título' : 'títulos'}`)),
    dados.itens.length
      ? grade(dados.itens.map((t) => cartaz(t, opcoesCartaz())))
      : vazio('Nada por aqui ainda com esses filtros.')));
}

async function telaMinhaLista() {
  const { itens } = await api.get('/tv/minha-lista');
  limpar(conteudo, el('div', { class: 'secao' },
    el('h1', {}, 'Minha lista'),
    itens.length
      ? grade(itens.map((t) => cartaz(t, opcoesCartaz())))
      : vazio('Sua lista está vazia. Toque em "Minha lista" na página de um filme ou série.',
        el('button', { class: 'btn primario', onclick: () => ir('#/') }, 'Ver o catálogo'))));
}

async function telaBusca(q) {
  if (!q || q.length < 2) return ir('#/');
  const r = await api.get(`/tv/busca?q=${encodeURIComponent(q)}`);
  const partes = [el('h1', {}, `Resultados para "${r.termo}"`)];
  if (r.titulos.length) partes.push(el('h2', { style: 'margin-top:18px' }, 'Filmes e séries'), grade(r.titulos.map((t) => cartaz(t, opcoesCartaz()))));
  if (r.canais.length) {
    partes.push(el('h2', { style: 'margin-top:26px' }, 'Canais'),
      el('div', { class: 'grade', style: 'grid-template-columns:repeat(auto-fill,minmax(300px,1fr))' },
        r.canais.map((c) => canalCartao({ ...c, agora: null }, { aoAbrir: tocarCanal }))));
  }
  if (r.programas.length) {
    partes.push(el('h2', { style: 'margin-top:26px' }, 'Na programação'),
      el('div', { class: 'coluna' }, r.programas.map((p) => el('button', {
        class: 'cartao fundo linha entre',
        style: 'text-align:left;cursor:pointer',
        onclick: () => ir('#/guia'),
      },
      el('div', {}, el('strong', {}, p.titulo), el('div', { class: 'pequeno mudo' }, `${p.canal_nome} · canal ${p.canal_numero} · ${hora(p.inicio)}`)),
      icone('seta')))));
  }
  if (!r.titulos.length && !r.canais.length && !r.programas.length) partes.push(vazio('Não encontramos nada com esse nome.'));
  limpar(conteudo, el('div', { class: 'secao' }, partes));
  return undefined;
}

// Guarda os arquivos do app (abre rápido e aguenta a rede oscilar); sem https, o navegador ignora.
registrarServiceWorker();

iniciar();
