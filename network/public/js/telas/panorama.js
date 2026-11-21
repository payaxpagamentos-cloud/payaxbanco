import { api, qs, baixarPost } from '../api.js';
import { el, limpar, icone, pode, painel, tabela, etqDe, rotulo, opcoes, dinheiro, dataHora, desde, dl, documento,
  telefone, numero, carregar, carregando, formulario, botao, toast, faixa, stat, vazio, modal, confirmar, cabecalho } from '../ui.js';
import { criarMapa } from '../mapa.js';

/*
 * Panorama: a operação inteira num mapa, em tela cheia.
 *
 * O mapa ocupa tudo o que sobra entre o menu e a borda; filtros, legenda e a ficha do ponto flutuam por
 * cima. Mapa dentro de um painel com margem é mapa pequeno, e aqui cada pixel a mais é um quarteirão a
 * mais que a equipe enxerga sem precisar arrastar.
 *
 * A regra que vale para tudo: COR NENHUMA é inventada. O verde e o vermelho saem da leitura do
 * concentrador; quando ninguém leu, ou a leitura é velha demais para valer, o ponto fica tracejado e a
 * tela diz por quê.
 */

const ESTADOS = ['conectado', 'sem_conexao', 'bloqueado', 'desconhecido', 'sem_servico', 'implantacao', 'suspenso', 'leitura_antiga', 'nunca_lido'];
const ABAS = [['mapa', 'Mapa'], ['calor', 'Onde mais cai'], ['viabilidade', 'Viabilidade'], ['fora', 'Fora do mapa']];

export default async function panorama({ alvo, query, ir, aoSair }) {
  let vivo = null;
  aoSair(() => { vivo?.destruir(); vivo = null; alvo.classList.remove('tela-cheia'); });
  const guardar = (m) => { vivo = m; return m; };
  const aba = query.aba ?? 'mapa';
  const filtro = { ...query };
  delete filtro.aba;

  // A aba "Fora do mapa" é uma tabela: não faz sentido roubar a tela inteira dela.
  const cheia = aba !== 'fora';
  alvo.classList.toggle('tela-cheia', cheia);
  if (!cheia) {
    limpar(alvo, cabecalho({ sobretitulo: 'Operação', titulo: 'Panorama', descricao: 'Contratos que não aparecem em mapa nenhum.' }),
      abas(aba, ir), el('div', { id: 'corpo-panorama' }));
    return telaForaDoMapa(document.getElementById('corpo-panorama'), ir);
  }

  const raiz = el('div', { class: 'panorama' });
  limpar(alvo, raiz);
  if (aba === 'calor') return telaCalor(raiz, ir, guardar);
  if (aba === 'viabilidade') return telaViabilidade(raiz, ir, guardar);
  return telaMapa(raiz, filtro, ir, guardar);
}

const abas = (ativa, ir) => el('div', { class: 'abas', role: 'tablist' },
  ABAS.map(([id, r]) => el('button', { role: 'tab', 'aria-selected': String(id === ativa), onclick: () => ir(`#/panorama?aba=${id}`) }, r)));

/**
 * O painel lateral começa logo abaixo do topo. A altura do topo NÃO é fixa: com muitos filtros ele quebra
 * em duas linhas, e um valor chutado faria o lateral cobrir a segunda — com os cliques indo para o painel
 * errado. Aqui ela é medida e vira uma variável de CSS.
 */
function acompanharTopo(raiz, topo) {
  const medir = () => raiz.style.setProperty('--topo-h', `${Math.ceil(topo.getBoundingClientRect().height)}px`);
  const observador = new ResizeObserver(medir);
  observador.observe(topo);
  medir();
  return () => observador.disconnect();
}

/* ---------------- Mapa ---------------- */

async function telaMapa(raiz, filtro, ir, guardar) {
  const caixaMapa = el('div', { class: 'mapa' });
  const topo = el('div', { class: 'painel-flutuante panorama-topo' }, carregando('Carregando…'));
  const rodape = el('div', { class: 'painel-flutuante panorama-rodape', hidden: true });
  const lateral = el('div', { class: 'painel-flutuante panorama-lateral', hidden: true });
  const aviso = el('div', { class: 'painel-flutuante panorama-aviso', hidden: true });
  limpar(raiz, caixaMapa, topo, aviso, rodape, lateral);
  acompanharTopo(raiz, topo);

  let dados;
  let camadas;
  let listas;
  try {
    [dados, camadas, listas] = await Promise.all([
      api.get(`/panorama/pontos${qs(filtro)}`), api.get('/panorama/camadas'), api.get('/panorama/filtros'),
    ]);
  } catch (err) { return limpar(topo, el('div', { class: 'falha' }, err.message)); }

  const recarregar = (mudanca) => ir(`#/panorama${qs({ ...filtro, ...mudanca })}`);
  const sel = (nome, rotuloVazio, itens, valorDe = (x) => x.id, textoDe = (x) => x.nome) =>
    el('select', { 'aria-label': rotuloVazio, onchange: (e) => recarregar({ [nome]: e.target.value }) },
      el('option', { value: '' }, rotuloVazio),
      itens.map((x) => el('option', { value: valorDe(x), selected: String(filtro[nome] ?? '') === String(valorDe(x)) }, textoDe(x))));

  const e = dados.por_estado;
  const semLeitura = (e.nunca_lido ?? 0) + (e.leitura_antiga ?? 0);
  const n = (v, classe) => el('span', { class: classe ?? '' }, el('b', {}, numero(v)));

  const m = guardar(await criarMapa(caixaMapa));
  const desenhados = m.indisponivel ? 0 : m.mostrarPanorama(dados.pontos, { aoAbrir: (p) => abrirPonto(p, lateral, ir) });
  const apoio = m.camadasApoio(camadas, { aoAbrirAtivo: (a) => ir(`#/rede/${a.id}`), aoAbrirChamado: (c) => ir(`#/chamados/${c.id}`) });
  const caixa = (texto, aoMudar) => el('label', {}, el('input', { type: 'checkbox', onchange: (ev) => aoMudar(ev.target.checked) }), texto);

  // No celular a barra inteira comeria metade da tela: os filtros ficam atrás de um botão.
  const filtros = el('div', { class: 'panorama-filtros' });
  const abrirFiltros = el('button', {
    class: 'botao secundario pequeno so-celular', 'aria-expanded': 'false',
    onclick: (ev) => { const aberto = filtros.classList.toggle('aberto'); ev.currentTarget.setAttribute('aria-expanded', String(aberto)); },
  }, icone('busca'), 'Filtros');

  limpar(filtros,
    el('input', {
      type: 'search', placeholder: 'Assinante, CPF/CNPJ ou login', value: filtro.busca ?? '', 'aria-label': 'Buscar no mapa',
      onchange: (ev) => recarregar({ busca: ev.target.value }),
    }),
    sel('estado', 'Todos os estados', ESTADOS.map((x) => ({ id: x, nome: rotulo('estadoConexao', x) }))),
    sel('plano_id', 'Todos os planos', listas.planos),
    sel('cto_id', 'Todas as caixas', listas.ctos, (x) => x.id, (x) => x.codigo),
    sel('concentrador_id', 'Concentradores', listas.concentradores),
    sel('bairro', 'Todos os bairros', listas.bairros.map((b) => ({ id: b, nome: b })), (x) => x.id),
    Object.keys(filtro).length ? botao('Limpar', () => ir('#/panorama'), { tipo: 'secundario pequeno', ic: 'fechar' }) : null);

  limpar(topo,
    abas('mapa', ir),
    el('span', { class: 'separador' }),
    abrirFiltros,
    filtros,
    el('div', { class: 'empurra panorama-resumo' },
      el('span', {}, n(e.conectado ?? 0), ' no ar'),
      el('span', { class: (e.sem_conexao ?? 0) ? 'atencao' : '' }, n(e.sem_conexao ?? 0), ' sem conexão'),
      el('span', {}, n(e.bloqueado ?? 0), ' cortados'),
      el('span', {}, n(semLeitura), ' sem leitura')),
    el('span', { class: 'separador' }),
    m.indisponivel ? null : caixa(`Caixas (${camadas.rede.length})`, (on) => m.alternarCamada(apoio.rede, on)),
    m.indisponivel ? null : caixa(`Chamados (${camadas.chamados.length})`, (on) => m.alternarCamada(apoio.chamados, on)),
    pode('panorama.area') && !m.indisponivel ? botao('Desenhar área', () => iniciarDesenho(m, aviso, filtro, ir), { tipo: 'secundario pequeno', ic: 'rota' }) : null,
    pode('panorama.area') ? botao('Varrer', () => varrer(() => recarregar({})), { tipo: 'secundario pequeno', ic: 'atualizar', titulo: 'Varrer as sessões dos concentradores agora' }) : null);

  if (dados.sem_coordenada) {
    aviso.hidden = false;
    limpar(aviso, faixa(`${numero(dados.sem_coordenada)} contrato(s) sem coordenada NÃO estão neste mapa (mostrando ${numero(dados.no_mapa)} de ${numero(dados.total)}).`, 'aviso', 'alerta'),
      el('div', { style: 'margin-top:8px' }, botao('Ver quem são', () => ir('#/panorama?aba=fora'), { tipo: 'secundario pequeno' })));
  }

  if (!m.indisponivel) {
    rodape.hidden = false;
    limpar(rodape,
      el('div', { class: 'legenda-mapa' },
        ['conectado', 'sem_conexao', 'bloqueado', 'desconhecido', 'implantacao', 'nunca_lido'].map((x) =>
          el('span', { class: x }, el('i', {}), el('span', { style: 'color:var(--texto-2)' }, rotulo('estadoConexao', x))))),
      el('div', { class: 'fraco', style: 'margin-top:8px' }, `${numero(desenhados)} ponto(s) no mapa · ${dados.fonte.explicacao}`));
  }
}

/** Ficha do ponto, flutuando sobre o mapa: tudo do assinante e as ações, sem trocar de tela. */
async function abrirPonto(ponto, lateral, ir) {
  lateral.hidden = false;
  limpar(lateral, carregando('Abrindo…'));
  let p;
  try { p = await api.get(`/panorama/contratos/${ponto.contrato_id}`); }
  catch (err) { return limpar(lateral, el('div', { class: 'falha' }, err.message)); }

  limpar(lateral,
    el('button', { class: 'botao-icone fechar', 'aria-label': 'Fechar', onclick: () => { lateral.hidden = true; } }, icone('fechar')),
    el('h2', {}, p.assinante_nome),
    faixa(p.motivo, p.atencao ? 'erro' : p.estado === 'conectado' ? '' : 'aviso', p.atencao ? 'alerta' : 'info'),
    dl([
      ['Estado', etqDe('estadoConexao', p.estado)],
      p.era ? ['Última leitura dizia', rotulo('estadoConexao', p.era)] : null,
      ['Desde', p.desde ? `${dataHora(p.desde)} (${desde(p.desde)})` : '—'],
      ['Lido em', p.lido_em ? `${dataHora(p.lido_em)} (${desde(p.lido_em)})` : 'Nunca'],
      ['Quedas hoje', numero(p.quedas_hoje)],
      ['Contrato', `#${p.contrato_numero} · ${rotulo('situacaoContrato', p.contrato_situacao)}`],
      ['Plano', `${p.plano_nome}${p.download_mbps ? ` · ${numero(p.download_mbps)} Mbps` : ''}`],
      ['Mensalidade', dinheiro(p.mensalidade_centavos)],
      ['Documento', documento(p.documento)],
      ['Telefone', telefone(p.telefone)],
      ['Endereço', [p.endereco, p.bairro].filter(Boolean).join(' · ') || '—'],
      ['Login', p.login ?? '—'],
      ['IP', p.ip ?? '—'],
      ['Concentrador', p.concentrador_nome ?? '—'],
      p.cto_codigo ? ['Caixa / porta', `${p.cto_codigo}${p.porta_numero ? ` · porta ${p.porta_numero}` : ''}`] : null,
      p.onu_serial ? ['ONU', `${p.onu_serial}${p.pon ? ` · PON ${p.pon}` : ''}`] : null,
    ]),
    el('div', { class: 'form-acoes', style: 'justify-content:flex-start' },
      botao('Abrir a ficha', () => ir(`#/assinantes/${p.assinante_id}`), { ic: 'pessoa' }),
      p.servico_id ? botao('Ler agora', async () => toast((await api.post(`/panorama/contratos/${p.contrato_id}/ler`, {})).aviso), { tipo: 'secundario', ic: 'atualizar' }) : null,
      pode('chamados.criar') ? botao('Abrir chamado', () => ir(`#/chamados?novo=1&assinante_id=${p.assinante_id}&contrato_id=${p.contrato_id}`), { tipo: 'secundario', ic: 'chamado' }) : null),
    p.historico.length
      ? el('details', { class: 'bloco-expansivel' }, el('summary', {}, 'Histórico de conexão', el('span', { class: 'num' }, numero(p.historico.length))),
        el('ul', { class: 'linha-tempo' }, p.historico.map((h) => el('li', {},
          etqDe('eventoConexao', h.evento), ' ',
          h.duracao_s !== null ? (h.evento === 'voltou' ? `ficou ${duracao(h.duracao_s)} fora do ar` : `estava no ar há ${duracao(h.duracao_s)}`) : '',
          el('small', {}, `${dataHora(h.em)}${h.ip ? ` · ${h.ip}` : ''}`)))))
      : el('p', { class: 'fraco' }, 'Sem mudança de estado registrada ainda.'));
}

const duracao = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`);

/* ---------------- Área ---------------- */

function iniciarDesenho(m, aviso, filtro, ir) {
  const antes = aviso.hidden;
  aviso.hidden = false;
  const controle = m.desenhar({
    aoFechar: async (area) => {
      if (!area) { aviso.hidden = antes; return; }
      limpar(aviso, carregando('Somando o que está dentro…'));
      try {
        const d = await api.post('/panorama/area', { area, filtros: filtro });
        aviso.hidden = antes;
        await mostrarImpacto(d, area, filtro, m, ir);
      } catch (err) { limpar(aviso, faixa(err.message, 'erro', 'alerta')); }
    },
  });
  limpar(aviso,
    faixa('Clique no mapa para marcar os cantos da área. Dois cliques fecham.', '', 'info'),
    el('div', { style: 'margin-top:8px' }, botao('Cancelar', () => { controle.cancelar(); m.limparArea(); }, { tipo: 'secundario pequeno', ic: 'fechar' })));
}

function mostrarImpacto(d, area, filtro, m, ir) {
  return modal('O que está dentro da área', (fechar) => [
    d.aviso ? faixa(d.aviso, 'aviso', 'alerta') : null,
    el('div', { class: 'stats compactas' },
      stat({ rotulo: 'Assinantes', valor: numero(d.assinantes) }),
      stat({ rotulo: 'Sem conexão', valor: numero(d.sem_conexao), notaTipo: d.sem_conexao ? 'erro' : '', semDado: !d.sem_conexao }),
      stat({ rotulo: 'Sem leitura', valor: numero(d.sem_leitura), nota: d.sem_leitura ? 'Podem estar fora do ar sem ninguém saber' : null,
        notaTipo: d.sem_leitura ? 'aviso' : '', semDado: !d.sem_leitura }),
      stat({ rotulo: 'Mensalidade na área', valor: dinheiro(d.mensalidade_centavos) })),
    d.ctos.length ? el('p', { class: 'fraco' }, `Caixas envolvidas: ${d.ctos.map((c) => `${c.codigo} (${c.assinantes})`).join(', ')}.`) : null,
    tabela([
      { titulo: 'Assinante', valor: (p) => el('div', {}, el('div', { class: 'forte' }, p.assinante_nome),
        el('div', { class: 'fraco' }, [p.endereco, p.bairro].filter(Boolean).join(' · '))) },
      { titulo: 'Estado', valor: (p) => etqDe('estadoConexao', p.estado) },
      { titulo: 'Quedas hoje', valor: (p) => numero(p.quedas_hoje), classe: 'num' },
      { titulo: 'Telefone', valor: (p) => telefone(p.telefone) },
    ], d.itens.slice(0, 100), { vazioTexto: 'Nenhum assinante dentro desta área.' }),
    d.itens.length > 100 ? el('p', { class: 'fraco' }, `Mostrando 100 de ${numero(d.itens.length)}. O CSV traz todos.`) : null,
    el('div', { class: 'modal-rodape' },
      d.assinantes && pode('panorama.area')
        ? botao('Abrir incidente com este impacto', () => { fechar(); abrirIncidente(d, area, filtro, ir); }, { ic: 'alerta' }) : null,
      d.assinantes ? botao('Baixar CSV', () => baixarArea(area, filtro), { tipo: 'secundario', ic: 'baixar' }) : null,
      botao('Apagar a área', () => { m.limparArea(); fechar(); }, { tipo: 'secundario', ic: 'fechar' })),
  ], { largo: true });
}

const baixarArea = (area, filtros) => baixarPost('/panorama/area/csv', { area, filtros }, 'area-panorama.csv');

const abrirIncidente = (d, area, filtros, ir) => formulario('Abrir incidente a partir da área', [
  { nome: 'titulo', rotulo: 'Título', obrigatorio: true, valor: `Queda em área com ${d.assinantes} assinante(s)` },
  { nome: 'severidade', rotulo: 'Severidade', tipo: 'select', obrigatorio: true, opcoes: opcoes('severidade'), valor: d.sem_conexao > 10 ? 'critica' : 'alta' },
  { nome: 'causa_provavel', rotulo: 'Causa provável', ajuda: 'O que se suspeita agora. Pode ser corrigido depois, no NOC.' },
  { nome: 'descricao', rotulo: 'Registro', tipo: 'textarea' },
], {
  rotuloEnviar: 'Abrir incidente',
  enviar: async (f) => {
    const r = await api.post('/panorama/area/incidente', { ...f, area, filtros });
    toast(`Incidente aberto com ${r.impacto.assinantes} assinante(s) na área.`);
    if (r.aviso) toast(r.aviso, true);
    ir(`#/noc/${r.id}`);
  },
});

/* ---------------- Onde mais cai ---------------- */

function telaCalor(raiz, ir, guardar) {
  const estado = { dias: 7, celula_m: 250 };
  const caixaMapa = el('div', { class: 'mapa' });
  const topo = el('div', { class: 'painel-flutuante panorama-topo' });
  const lateral = el('div', { class: 'painel-flutuante panorama-lateral' }, carregando('Somando as quedas…'));
  limpar(raiz, caixaMapa, topo, lateral);
  acompanharTopo(raiz, topo);
  let mapa = null;

  const desenhar = async () => {
    limpar(lateral, carregando('Somando as quedas…'));
    let d;
    try { d = await api.get(`/panorama/calor${qs(estado)}`); }
    catch (err) { return limpar(lateral, el('div', { class: 'falha' }, err.message)); }
    limpar(lateral,
      el('h2', {}, 'Onde a rede mais cai'),
      el('div', { class: 'stats compactas' },
        stat({ rotulo: 'Quedas', valor: numero(d.quedas) }),
        stat({ rotulo: 'Assinantes', valor: numero(d.assinantes_afetados) }),
        stat({ rotulo: 'Células', valor: numero(d.celulas.length) })),
      faixa(d.ressalva, '', 'info'),
      d.celulas.length
        ? tabela([
          { titulo: 'Região', valor: (c) => `${c.centro.lat.toFixed(4)}, ${c.centro.lng.toFixed(4)}` },
          { titulo: 'Quedas', valor: (c) => numero(c.quedas), classe: 'num' },
          { titulo: 'Assinantes', valor: (c) => numero(c.assinantes), classe: 'num' },
        ], d.celulas.slice(0, 20), { vazioTexto: 'Nenhuma queda no período.' })
        : vazio('Nenhuma queda registrada no período.',
          'Ou a rede esteve estável, ou a varredura de sessões ainda não rodou tempo suficiente para ter o que comparar.'));
    mapa?.mostrarCalor(d.celulas, (c) => toast(`${c.quedas} queda(s) em ${c.assinantes} assinante(s) nesta célula.`));
  };

  limpar(topo, abas('calor', ir), el('span', { class: 'separador' }),
    el('select', { 'aria-label': 'Período', onchange: (ev) => { estado.dias = Number(ev.target.value); desenhar(); } },
      [[1, 'Últimas 24 horas'], [7, 'Últimos 7 dias'], [30, 'Últimos 30 dias'], [90, 'Últimos 90 dias']]
        .map(([v, r]) => el('option', { value: v, selected: estado.dias === v }, r))),
    el('select', { 'aria-label': 'Tamanho da célula', onchange: (ev) => { estado.celula_m = Number(ev.target.value); desenhar(); } },
      [[100, 'Célula de 100 m'], [250, 'Célula de 250 m'], [500, 'Célula de 500 m'], [1000, 'Célula de 1 km']]
        .map(([v, r]) => el('option', { value: v, selected: estado.celula_m === v }, r))));

  criarMapa(caixaMapa).then((m) => { mapa = guardar(m); desenhar(); });
}

/* ---------------- Viabilidade ---------------- */

function telaViabilidade(raiz, ir, guardar) {
  const caixaMapa = el('div', { class: 'mapa' });
  const topo = el('div', { class: 'painel-flutuante panorama-topo' });
  const lateral = el('div', { class: 'painel-flutuante panorama-lateral' });
  limpar(raiz, caixaMapa, topo, lateral);
  acompanharTopo(raiz, topo);
  let mapa = null;
  let camadaCaixas = null;
  let raio = 300;

  const consultar = async (lat, lng) => {
    limpar(lateral, carregando('Procurando caixa com porta livre…'));
    let d;
    try { d = await api.get(`/panorama/viabilidade${qs({ lat, lng, raio_m: raio })}`); }
    catch (err) { return limpar(lateral, el('div', { class: 'falha' }, err.message)); }
    limpar(lateral,
      el('h2', {}, 'Caixas próximas'),
      faixa(d.resumo, d.atendivel ? '' : 'aviso', d.atendivel ? 'ok' : 'alerta'),
      tabela([
        { titulo: 'Caixa', valor: (c) => el('div', {}, el('div', { class: 'forte' }, c.codigo), el('div', { class: 'fraco' }, c.bairro ?? '—')) },
        { titulo: 'Distância', valor: (c) => `${numero(c.distancia_m)} m`, classe: 'num' },
        { titulo: 'Portas', valor: (c) => (c.portas ? `${c.portas.livre ?? 0} de ${c.portas.total}` : el('span', { class: 'fraco' }, 'Não cadastradas')) },
        { titulo: 'Atende?', valor: (c) => el('div', {}, etqDe('statusAtivo', c.livre ? 'operacional' : 'indisponivel'),
          c.observacao ? el('div', { class: 'fraco' }, c.observacao) : null) },
      ], d.caixas, { vazioTexto: 'Nenhuma caixa cadastrada neste raio.' }),
      faixa(d.ressalva, 'aviso', 'info'));
    if (mapa && !mapa.indisponivel) {
      mapa.alternarCamada(camadaCaixas, false);
      camadaCaixas = mapa.camadasApoio({ rede: d.caixas, chamados: [] }).rede;
      mapa.alternarCamada(camadaCaixas, true);
      mapa.enquadrar([[Number(lat), Number(lng)], ...d.caixas.map((c) => [c.lat, c.lng])]);
    }
  };

  limpar(topo, abas('viabilidade', ir), el('span', { class: 'separador' }),
    el('select', { 'aria-label': 'Raio de busca', onchange: (ev) => { raio = Number(ev.target.value); } },
      [[150, 'Raio de 150 m'], [300, 'Raio de 300 m'], [600, 'Raio de 600 m'], [1200, 'Raio de 1,2 km']]
        .map(([v, r]) => el('option', { value: v, selected: raio === v }, r))),
    el('span', { class: 'empurra fraco' }, 'Clique no mapa onde o cliente quer ser atendido.'));
  limpar(lateral, vazio('Escolha um ponto no mapa.', 'O sistema mostra as caixas mais próximas e se ainda há porta livre.'));

  criarMapa(caixaMapa).then(async (m) => {
    mapa = guardar(m);
    if (m.indisponivel) return;
    m.maps.event.addListener(m.mapa, 'click', (ev) => consultar(ev.latLng.lat().toFixed(6), ev.latLng.lng().toFixed(6)));
    // Abrir no centro genérico faria o primeiro clique cair longe de qualquer caixa e responder
    // "nenhuma caixa por perto" — verdade inútil. A tela começa mostrando a rede que existe.
    try {
      const { rede } = await api.get('/panorama/camadas');
      const comPonto = rede.filter((a) => a.lat !== null && a.lng !== null);
      if (!comPonto.length) return;
      camadaCaixas = m.camadasApoio({ rede: comPonto, chamados: [] }).rede;
      m.alternarCamada(camadaCaixas, true);
      m.enquadrar(comPonto.map((a) => [a.lat, a.lng]));
    } catch { /* sem rede cadastrada: fica no centro da operação */ }
  });
  void ir;
}

/* ---------------- Fora do mapa ---------------- */

function telaForaDoMapa(corpo, ir) {
  return carregar(corpo, () => api.get('/panorama/sem-coordenada'), (d) => [
    d.total
      ? faixa(`${numero(d.total)} contrato(s) não aparecem em mapa nenhum por não terem coordenada. Enquanto estiverem assim, `
        + 'ficam de fora de toda área desenhada e de todo cálculo de impacto.', 'aviso', 'alerta')
      : faixa('Todo contrato tem coordenada: o mapa mostra a carteira inteira.', '', 'ok'),
    painel(null, tabela([
      { titulo: 'Assinante', valor: (x) => el('div', {}, el('div', { class: 'forte' }, x.assinante_nome), el('div', { class: 'fraco' }, `Contrato #${x.contrato_numero}`)) },
      { titulo: 'Endereço', valor: (x) => [x.endereco, x.bairro].filter(Boolean).join(' · ') || el('span', { class: 'fraco' }, 'Sem endereço') },
      { titulo: 'Estado', valor: (x) => etqDe('estadoConexao', x.estado) },
      { titulo: '', valor: (x) => botao('Corrigir', () => ir(`#/contratos/${x.contrato_id}`), { tipo: 'secundario pequeno', ic: 'pino' }), classe: 'acoes-celula' },
    ], d.itens, { vazioTexto: 'Nenhum contrato fora do mapa.' }), { semCorpo: Boolean(d.itens.length) }),
  ]);
}

/* ---------------- Varredura ---------------- */

async function varrer(recarregar) {
  if (!await confirmar('Varrer os concentradores agora',
    'O sistema vai pedir a lista de sessões ativas a cada concentrador e atualizar o estado de toda a carteira. '
    + 'É uma chamada por concentrador, não uma por assinante.', 'Varrer')) return;
  try {
    const r = await api.post('/panorama/varredura', {});
    toast(`${numero(r.servicos)} serviço(s) conferidos · ${r.caiu} queda(s) e ${r.voltou} retorno(s) desde a última varredura.`);
    if (r.aviso) toast(r.aviso, true);
    recarregar();
  } catch (err) { toast(err.message, true); }
}
