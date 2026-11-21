import { api, qs, baixarPost } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, etqDe, rotulo, opcoes, dinheiro, dataHora, desde, dl, documento,
  telefone, numero, carregar, carregando, formulario, botao, toast, faixa, stat, vazio, modal, confirmar } from '../ui.js';
import { criarMapa } from '../mapa.js';

/*
 * Panorama: a operação inteira num mapa.
 *
 * Nenhuma cor aqui é chute. O verde e o vermelho saem da varredura das sessões do concentrador; quando
 * ninguém leu, ou a leitura envelheceu, a casinha fica tracejada e a tela diz por quê. Mapa que pinta de
 * verde o que não sabe manda a equipe dormir tranquila com o assinante fora do ar.
 */

const ESTADOS = ['conectado', 'sem_conexao', 'bloqueado', 'desconhecido', 'sem_servico', 'implantacao', 'suspenso', 'leitura_antiga', 'nunca_lido'];

export default async function panorama({ alvo, query, ir, aoSair }) {
  let vivo = null;
  // O harness avisa quando a tela sai: é ali que o mapa é desmontado, sem estado global.
  aoSair(() => { vivo?.destruir(); vivo = null; });
  const guardar = (m) => { vivo = m; return m; };
  const filtro = { ...query };
  delete filtro.aba;
  const aba = query.aba ?? 'mapa';

  const corpo = el('div');
  limpar(alvo, cabecalho({
    sobretitulo: 'Operação',
    titulo: 'Panorama',
    descricao: 'Cada casinha é um contrato no endereço dele. A cor diz o que fazer: quem caiu, quem foi cortado por '
      + 'inadimplência e quem o sistema ainda não leu são coisas diferentes e aparecem diferentes.',
    acoes: [
      pode('panorama.area') ? botao('Varrer agora', () => varrer(() => panorama({ alvo, query, ir })), { tipo: 'secundario', ic: 'atualizar' }) : null,
    ],
  }), el('div', { class: 'abas', role: 'tablist' },
    [['mapa', 'Mapa'], ['calor', 'Onde mais cai'], ['viabilidade', 'Viabilidade'], ['fora', 'Fora do mapa']]
      .map(([id, r]) => el('button', { role: 'tab', 'aria-selected': String(id === aba), onclick: () => ir(`#/panorama?aba=${id}`) }, r))),
  corpo);

  if (aba === 'calor') return telaCalor(corpo, guardar);
  if (aba === 'viabilidade') return telaViabilidade(corpo, guardar);
  if (aba === 'fora') return telaForaDoMapa(corpo, ir);
  return telaMapa(corpo, filtro, ir, guardar);
}

// ---------------- Mapa ----------------
async function telaMapa(corpo, filtro, ir, guardar) {
  limpar(corpo, carregando('Carregando o mapa…'));
  let dados;
  let camadas;
  let listas;
  try {
    [dados, camadas, listas] = await Promise.all([
      api.get(`/panorama/pontos${qs(filtro)}`), api.get('/panorama/camadas'), api.get('/panorama/filtros'),
    ]);
  } catch (err) { return limpar(corpo, el('div', { class: 'falha' }, err.message)); }

  const caixaMapa = el('div', { class: 'mapa mapa-panorama' });
  const lateral = el('div');
  const barraDesenho = el('div');
  const cab = el('div', { class: 'camadas-mapa' });

  const recarregar = (mudanca) => ir(`#/panorama${qs({ ...filtro, ...mudanca, aba: undefined })}`);
  const sel = (nome, rotuloVazio, itens, valorDe = (x) => x.id, textoDe = (x) => x.nome) =>
    el('select', { 'aria-label': rotuloVazio, onchange: (e) => recarregar({ [nome]: e.target.value }) },
      el('option', { value: '' }, rotuloVazio),
      itens.map((x) => el('option', { value: valorDe(x), selected: String(filtro[nome] ?? '') === String(valorDe(x)) }, textoDe(x))));

  limpar(corpo,
    dados.sem_coordenada
      ? faixa(`${numero(dados.sem_coordenada)} contrato(s) não têm coordenada e NÃO estão neste mapa. O mapa mostra ${numero(dados.no_mapa)} de ${numero(dados.total)}.`,
        'aviso', 'alerta')
      : null,
    el('div', { class: 'stats' },
      stat({ rotulo: 'No ar', valor: numero(dados.por_estado.conectado ?? 0), nota: 'Sessão ativa na última varredura', ic: 'ok' }),
      stat({ rotulo: 'Sem conexão', valor: numero(dados.por_estado.sem_conexao ?? 0), nota: (dados.por_estado.sem_conexao ?? 0) ? 'Contrato ativo e fora do ar: é defeito' : 'Nenhum contrato ativo fora do ar',
        notaTipo: (dados.por_estado.sem_conexao ?? 0) ? 'erro' : 'ok', ic: 'alerta', semDado: !(dados.por_estado.sem_conexao ?? 0) }),
      stat({ rotulo: 'Cortados', valor: numero(dados.por_estado.bloqueado ?? 0), nota: 'Inadimplência: fora do ar é o esperado', ic: 'cadeado' }),
      stat({ rotulo: 'Sem leitura', valor: numero((dados.por_estado.nunca_lido ?? 0) + (dados.por_estado.leitura_antiga ?? 0)),
        nota: 'O sistema não sabe dizer o estado destes', ic: 'relogio', semDado: !((dados.por_estado.nunca_lido ?? 0) + (dados.por_estado.leitura_antiga ?? 0)) })),
    faixa(dados.fonte.explicacao, dados.fonte.varredura_min ? '' : 'aviso', 'info'),
    el('div', { class: 'filtros' },
      el('input', {
        type: 'search', class: 'busca', placeholder: 'Assinante, CPF/CNPJ ou login', value: filtro.busca ?? '', 'aria-label': 'Buscar no mapa',
        onchange: (e) => recarregar({ busca: e.target.value }),
      }),
      sel('estado', 'Todos os estados', ESTADOS.map((e) => ({ id: e, nome: rotulo('estadoConexao', e) }))),
      sel('plano_id', 'Todos os planos', listas.planos),
      sel('cto_id', 'Todas as caixas', listas.ctos, (x) => x.id, (x) => x.codigo),
      sel('concentrador_id', 'Todos os concentradores', listas.concentradores),
      sel('bairro', 'Todos os bairros', listas.bairros.map((b) => ({ id: b, nome: b })), (x) => x.id),
      Object.keys(filtro).length ? botao('Limpar filtros', () => ir('#/panorama'), { tipo: 'secundario pequeno', ic: 'fechar' }) : null),
    el('div', { class: 'grade principal-lateral' },
      // A barra de desenho fica SOBRE o mapa: aparecer empurrando o mapa para baixo tiraria do lugar
      // justamente o que a pessoa vai clicar em seguida.
      el('div', {}, painel(null, [cab, el('div', { class: 'painel-mapa' }, caixaMapa, barraDesenho),
      el('div', { class: 'legenda-mapa' },
          ['conectado', 'sem_conexao', 'bloqueado', 'desconhecido', 'implantacao', 'nunca_lido'].map((e) =>
            el('span', { class: e }, el('i', {}), el('span', { style: 'color:var(--texto-2)' }, rotulo('estadoConexao', e)))))], { semCorpo: false })),
      el('div', {}, lateral)));

  limpar(lateral, vazio('Clique numa casinha.', 'Os dados do assinante e as ações aparecem aqui, sem sair do mapa.'));

  const m = guardar(await criarMapa(caixaMapa));
  const desenhados = m.mostrarPanorama(dados.pontos, { aoAbrir: (p) => abrirPonto(p, lateral, ir) });
  const apoio = m.camadasApoio(camadas, {
    aoAbrirAtivo: (a) => ir(`#/rede/${a.id}`),
    aoAbrirChamado: (c) => ir(`#/chamados/${c.id}`),
  });

  const caixa = (texto, aoMudar, marcado = false) => {
    const c = el('input', { type: 'checkbox', checked: marcado, onchange: (e) => aoMudar(e.target.checked) });
    return el('label', {}, c, texto);
  };
  limpar(cab,
    caixa(`Caixas ópticas (${camadas.rede.length})`, (on) => m.alternarCamada(apoio.rede, on)),
    caixa(`Chamados abertos (${camadas.chamados.length})`, (on) => m.alternarCamada(apoio.chamados, on)),
    el('span', { class: 'fraco', style: 'margin-left:auto' }, `${numero(desenhados)} ponto(s) no mapa`),
    pode('panorama.area') ? botao('Desenhar área', () => iniciarDesenho(m, barraDesenho, filtro, ir), { tipo: 'secundario pequeno', ic: 'rota' }) : null);
}

/** Painel lateral do ponto: tudo do assinante e as ações, sem trocar de tela. */
async function abrirPonto(ponto, lateral, ir) {
  limpar(lateral, carregando('Abrindo…'));
  let p;
  try { p = await api.get(`/panorama/contratos/${ponto.contrato_id}`); }
  catch (err) { return limpar(lateral, el('div', { class: 'falha' }, err.message)); }

  const acoes = [
    botao('Abrir a ficha', () => ir(`#/assinantes/${p.assinante_id}`), { ic: 'pessoa' }),
    p.servico_id ? botao('Ler agora', async () => {
      const r = await api.post(`/panorama/contratos/${p.contrato_id}/ler`, {});
      toast(r.aviso);
    }, { tipo: 'secundario', ic: 'atualizar' }) : null,
    pode('chamados.criar') ? botao('Abrir chamado', () => ir(`#/chamados?novo=1&assinante_id=${p.assinante_id}&contrato_id=${p.contrato_id}`), { tipo: 'secundario', ic: 'chamado' }) : null,
  ];

  limpar(lateral, painel(p.assinante_nome, [
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
    el('div', { class: 'form-acoes', style: 'justify-content:flex-start' }, acoes),
    p.historico.length
      ? el('details', { class: 'bloco-expansivel' }, el('summary', {}, 'Histórico de conexão', el('span', { class: 'num' }, numero(p.historico.length))),
        el('ul', { class: 'linha-tempo' }, p.historico.map((h) => el('li', {},
          etqDe('eventoConexao', h.evento), ' ',
          h.duracao_s !== null ? (h.evento === 'voltou' ? `ficou ${duracao(h.duracao_s)} fora do ar` : `estava no ar há ${duracao(h.duracao_s)}`) : '',
          el('small', {}, `${dataHora(h.em)}${h.ip ? ` · ${h.ip}` : ''}`)))))
      : el('p', { class: 'fraco' }, 'Sem mudança de estado registrada ainda.'),
  ]));
}

const duracao = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`);

// ---------------- Área ----------------
function iniciarDesenho(m, barra, filtro, ir) {
  const aviso = el('span', {}, 'Clique no mapa para marcar os cantos da área. Dois cliques fecham.');
  const controle = m.desenhar({
    aoFechar: async (area) => {
      limpar(barra);
      if (!area) return;
      limpar(barra, carregando('Somando o que está dentro…'));
      try {
        const d = await api.post('/panorama/area', { area, filtros: filtro });
        limpar(barra);
        await mostrarImpacto(d, area, filtro, m, ir);
      } catch (err) { limpar(barra, faixa(err.message, 'erro', 'alerta')); }
    },
  });
  limpar(barra, aviso,
    botao('Fechar a área', () => controle.concluir(), { tipo: 'secundario pequeno', ic: 'ok' }),
    botao('Cancelar', () => { controle.cancelar(); m.limparArea(); }, { tipo: 'secundario pequeno', ic: 'fechar' }));
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
    d.ctos.length
      ? el('p', { class: 'fraco' }, `Caixas envolvidas: ${d.ctos.map((c) => `${c.codigo} (${c.assinantes})`).join(', ')}.`)
      : null,
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
        ? botao('Abrir incidente com este impacto', () => { fechar(); abrirIncidente(d, area, filtro, ir); }, { ic: 'alerta' })
        : null,
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

// ---------------- Onde mais cai ----------------
function telaCalor(corpo, guardar) {
  const estado = { dias: 7, celula_m: 250 };
  let mapa = null;
  const caixaMapa = el('div', { class: 'mapa mapa-panorama' });
  const resumo = el('div');
  const desenhar = async () => {
    limpar(resumo, carregando('Somando as quedas…'));
    let d;
    try { d = await api.get(`/panorama/calor${qs(estado)}`); }
    catch (err) { return limpar(resumo, el('div', { class: 'falha' }, err.message)); }
    limpar(resumo,
      el('div', { class: 'stats compactas' },
        stat({ rotulo: 'Quedas no período', valor: numero(d.quedas) }),
        stat({ rotulo: 'Assinantes atingidos', valor: numero(d.assinantes_afetados) }),
        stat({ rotulo: 'Células com queda', valor: numero(d.celulas.length) }),
        stat({ rotulo: 'Lado da célula', valor: `${numero(d.periodo.celula_m)} m` })),
      faixa(d.ressalva, '', 'info'),
      d.celulas.length
        ? tabela([
          { titulo: 'Região', valor: (c) => `${c.centro.lat.toFixed(4)}, ${c.centro.lng.toFixed(4)}` },
          { titulo: 'Quedas', valor: (c) => numero(c.quedas), classe: 'num' },
          { titulo: 'Assinantes', valor: (c) => numero(c.assinantes), classe: 'num' },
        ], d.celulas.slice(0, 15), { vazioTexto: 'Nenhuma queda registrada no período.' })
        : vazio('Nenhuma queda registrada no período.',
          'Ou a rede esteve estável, ou a varredura de sessões ainda não rodou tempo suficiente para ter o que comparar.'));
    if (mapa) mapa.mostrarCalor(d.celulas, (c) => toast(`${c.quedas} queda(s) em ${c.assinantes} assinante(s) nesta célula.`));
  };

  limpar(corpo,
    el('div', { class: 'filtros' },
      el('select', { 'aria-label': 'Período', onchange: (e) => { estado.dias = Number(e.target.value); desenhar(); } },
        [[1, 'Últimas 24 horas'], [7, 'Últimos 7 dias'], [30, 'Últimos 30 dias'], [90, 'Últimos 90 dias']]
          .map(([v, r]) => el('option', { value: v, selected: estado.dias === v }, r))),
      el('select', { 'aria-label': 'Tamanho da célula', onchange: (e) => { estado.celula_m = Number(e.target.value); desenhar(); } },
        [[100, 'Célula de 100 m'], [250, 'Célula de 250 m'], [500, 'Célula de 500 m'], [1000, 'Célula de 1 km']]
          .map(([v, r]) => el('option', { value: v, selected: estado.celula_m === v }, r)))),
    el('div', { class: 'grade principal-lateral' },
      el('div', {}, painel('Onde a rede mais cai', caixaMapa)),
      el('div', {}, resumo)));

  criarMapa(caixaMapa).then((m) => { mapa = guardar(m); desenhar(); });
}

// ---------------- Viabilidade ----------------
function telaViabilidade(corpo, guardar) {
  const caixaMapa = el('div', { class: 'mapa mapa-panorama' });
  const resultado = el('div');
  let mapa = null;
  let camadaCaixas = null;

  const consultar = async (lat, lng, raio) => {
    limpar(resultado, carregando('Procurando caixa com porta livre…'));
    let d;
    try { d = await api.get(`/panorama/viabilidade${qs({ lat, lng, raio_m: raio })}`); }
    catch (err) { return limpar(resultado, el('div', { class: 'falha' }, err.message)); }
    limpar(resultado,
      faixa(d.resumo, d.atendivel ? '' : 'aviso', d.atendivel ? 'ok' : 'alerta'),
      tabela([
        { titulo: 'Caixa', valor: (c) => el('div', {}, el('div', { class: 'forte' }, c.codigo), el('div', { class: 'fraco' }, c.bairro ?? '—')) },
        { titulo: 'Distância', valor: (c) => `${numero(c.distancia_m)} m`, classe: 'num' },
        { titulo: 'Portas', valor: (c) => (c.portas ? `${c.portas.livre ?? 0} livre(s) de ${c.portas.total}` : el('span', { class: 'fraco' }, 'Não cadastradas')) },
        { titulo: 'Atende?', valor: (c) => el('div', {}, c.livre ? etqDe('statusAtivo', 'operacional') : etqDe('statusAtivo', 'indisponivel'),
          c.observacao ? el('div', { class: 'fraco' }, c.observacao) : null) },
      ], d.caixas, { vazioTexto: 'Nenhuma caixa cadastrada neste raio.' }),
      faixa(d.ressalva, 'aviso', 'info'));
    if (mapa) {
      // Caixa óptica é pino de rede, não casinha de assinante: usar o ícone errado confundiria as duas coisas.
      mapa.limparArea();
      mapa.alternarCamada(camadaCaixas, false);
      camadaCaixas = mapa.camadasApoio({ rede: d.caixas, chamados: [] }).rede;
      mapa.alternarCamada(camadaCaixas, true);
      mapa.enquadrar([[Number(lat), Number(lng)], ...d.caixas.map((c) => [c.lat, c.lng])]);
    }
  };

  limpar(corpo,
    faixa('Clique no mapa onde o cliente quer ser atendido. O sistema mostra as caixas mais próximas e se ainda há porta livre.', '', 'info'),
    el('div', { class: 'grade principal-lateral' },
      el('div', {}, painel('Onde o cliente está', caixaMapa)),
      el('div', {}, painel('Caixas próximas', resultado))));
  limpar(resultado, vazio('Escolha um ponto no mapa.', 'Também dá para digitar a coordenada, se você já tiver.'));

  criarMapa(caixaMapa).then(async (m) => {
    mapa = guardar(m);
    m.mapa?.on('click', (e) => consultar(e.latlng.lat.toFixed(6), e.latlng.lng.toFixed(6), 300));
    /*
     * Abrir no centro genérico da organização faria o primeiro clique cair longe de qualquer caixa e
     * responder "nenhuma caixa por perto" — verdade inútil. A tela começa mostrando a rede que existe.
     */
    try {
      const { rede } = await api.get('/panorama/camadas');
      const comPonto = rede.filter((a) => a.lat !== null && a.lng !== null);
      if (!comPonto.length) return;
      camadaCaixas = m.camadasApoio({ rede: comPonto, chamados: [] }).rede;
      m.alternarCamada(camadaCaixas, true);
      m.enquadrar(comPonto.map((a) => [a.lat, a.lng]));
    } catch { /* sem rede cadastrada: o mapa fica no centro da operação mesmo */ }
  });
}

// ---------------- Fora do mapa ----------------
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

// ---------------- Varredura ----------------
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

