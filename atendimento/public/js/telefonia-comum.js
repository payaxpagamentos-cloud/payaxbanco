/**
 * Peças de tela da telefonia (vieram do PABX): cartões do painel, a lista de chamadas com filtros e
 * os relatórios. Usam os mesmos blocos do resto da ZOE (cartao, tabela, botão...).
 */
import { api, baixar, qs } from './api.js';
import { el, limpar, dinheiro, dataHora, duracao, minutos, inteiro, telefone, etiqueta, barraUso, toast, acao, campo,
  escolha, hojeLocal, somarDias, modal, formModal, confirmar, icone } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone } from './comum.js';
import { pizza, linhaDoDia, barras, CORES } from './graficos.js';

export const DIRECOES = { entrada: 'Recebida', saida: 'Realizada', interna: 'Interna' };
export const TIPOS_EMPRESA = { pabx: 'PABX', discador: 'Discador', callcenter: 'Call center' };
export const TIPOS_DESTINO = { interno: 'Interno', fixo: 'Fixo', movel: 'Móvel', internacional: 'Internacional' };
export const STATUS_CHAMADA = { em_curso: ['Em curso', 'info'], atendida: ['Atendida', 'ok'], nao_atendida: ['Não atendida', 'aviso'], ocupado: ['Ocupado', 'aviso'], falha: ['Falha', 'erro'] };
export const etiquetaChamada = (s) => etiqueta(STATUS_CHAMADA[s]?.[0] ?? s, STATUS_CHAMADA[s]?.[1]);

export function cartaoUtilizacao(u) {
  const linha = (rotulo, hoje, mes) => el('tr', {}, el('td', {}, rotulo), td(hoje, 'centro num'), td(mes, 'centro num'));
  return cartao('Utilização', el('div', { class: 'rolagem' }, el('table', { class: 'tabela tabela-utilizacao' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Chamadas'), el('th', { class: 'centro' }, 'Hoje'), el('th', { class: 'centro' }, 'Mês'))),
    el('tbody', {},
      linha('Recebidas', inteiro(u.hoje.recebidas), inteiro(u.mes.recebidas)),
      linha('Realizadas', inteiro(u.hoje.realizadas), inteiro(u.mes.realizadas)),
      linha('Gastos (Realizadas)', dinheiro(u.hoje.gastos_centavos), dinheiro(u.mes.gastos_centavos))))));
}
export const cartaoSimultaneas = (s, emCurso) => cartao('Chamadas Simultâneas', linhaDoDia(s.pontos, { passoMin: s.passo_min }),
  el('div', { class: 'pequeno mudo', style: 'margin-top:6px' }, `Agora: ${emCurso} · pico de hoje: ${s.pico}`));
export const cartaoRamais = (r) => cartao('Ramais', pizza([{ rotulo: 'Online', valor: r.online, cor: CORES.verde }, { rotulo: 'Offline', valor: r.offline, cor: CORES.cinza }],
  { vazio: 'Nenhum ramal cadastrado', centro: { valor: inteiro(r.total), rotulo: 'Ramais' } }));
/** Status das ligações de hoje: atendidas, perdidas e em curso, com o total no centro. */
export function cartaoStatusLigacoes(hoje, emCurso) {
  const total = hoje.recebidas + hoje.realizadas + hoje.internas;
  return cartao('Status das ligações', pizza([
    { rotulo: 'Atendidas', valor: hoje.atendidas, cor: CORES.verde },
    { rotulo: 'Perdidas', valor: hoje.perdidas, cor: CORES.vermelho },
    { rotulo: 'Em curso', valor: emCurso, cor: CORES.amarelo },
  ], { vazio: 'Nenhuma ligação hoje', centro: { valor: inteiro(total), rotulo: 'Total' }, lado: true }));
}
/** Indicadores do topo do dashboard: ligações, ramais, em atendimento e TMA. */
export function indicadoresTelefonia(d) {
  const h = d.utilizacao.hoje;
  const total = h.recebidas + h.realizadas + h.internas;
  return [
    indicador('Ligações hoje', inteiro(total), `${inteiro(h.recebidas)} recebidas · ${inteiro(h.realizadas)} realizadas`, 'chamadas', 'azul'),
    indicador('Ramais online', `${inteiro(d.ramais.online)}/${inteiro(d.ramais.total)}`, d.ramais.offline ? `${d.ramais.offline} offline` : 'todos online', 'pessoas', 'roxo'),
    indicador('Em atendimento', inteiro(d.em_curso), `pico de hoje: ${d.simultaneas.pico}`, 'headset', 'verde'),
    indicador('TMA (médio)', duracao(h.tma_s), 'tempo médio das atendidas', 'relogio', 'laranja'),
  ];
}
export function cartaoUsoMes(uso) {
  const v = (k) => uso[k]?.tarifado_s ?? 0;
  return cartao('Uso mês atual', pizza([
    { rotulo: 'Móvel', valor: v('movel'), cor: CORES.amarelo },
    { rotulo: 'Fixo', valor: v('fixo'), cor: CORES.azul },
    { rotulo: 'Internacional', valor: v('internacional'), cor: CORES.verde },
  ], { formato: minutos, vazio: 'Nenhuma ligação externa no mês' }),
  el('div', { class: 'pequeno mudo', style: 'text-align:center;margin-top:8px' },
    `Gasto no mês: ${dinheiro(['fixo', 'movel', 'internacional'].reduce((s, k) => s + (uso[k]?.custo_centavos ?? 0), 0))}`));
}
export function cartaoRecursos(r) {
  const linha = (rotulo, x) => el('tr', {}, td(rotulo, 'centro'), el('td', { style: 'width:45%' }, barraUso(x.usado, x.limite)));
  return cartao('Recursos de voz e texto', el('table', { class: 'tabela tabela-utilizacao' },
    el('thead', {}, el('tr', {}, el('th', { class: 'centro' }, 'Recurso'), el('th', {}, 'Uso no mês'))),
    el('tbody', {}, linha('Texto para voz (TTS)', r.tts), linha('Voz para texto (STT)', r.stt))));
}

// ---------- Chamadas ----------
/**
 * Lista de chamadas com filtros, paginação e exportação. `caminho`: '/master/chamadas' ou '/empresas/ID/chamadas'.
 * `filtrosFixos`: filtros que não aparecem na tela (ex.: campanha).
 */
export function painelChamadas(alvo, caminho, { master = false, empresas = [], filtrosFixos = {}, aoAtualizar } = {}) {
  const hoje = hojeLocal();
  const estado = { de: somarDias(hoje, -6), ate: hoje, direcao: '', status: '', busca: '', ramal: '', empresa_id: '', pagina: 1, ...filtrosFixos };
  const lista = el('div');
  const resumo = el('div', { class: 'pequeno mudo' });
  const campoF = (rotulo, nome, attrs = {}) => {
    const i = el('input', { value: estado[nome], ...attrs });
    i.addEventListener('change', () => { estado[nome] = i.value; estado.pagina = 1; carregar(); });
    return el('label', { class: 'campo' }, rotulo, i);
  };
  const seletor = (rotulo, nome, opcoes) => {
    const s = escolha(null, nome, { '': 'Todas', ...opcoes }, estado[nome]);
    s.addEventListener('change', () => { estado[nome] = s.value; estado.pagina = 1; carregar(); });
    return el('label', { class: 'campo' }, rotulo, s);
  };
  const filtros = el('div', { class: 'filtros livre' },
    campoF('De', 'de', { type: 'date' }), campoF('Até', 'ate', { type: 'date' }),
    master ? seletor('Empresa', 'empresa_id', Object.fromEntries(empresas.map((e) => [e.id, e.nome]))) : null,
    seletor('Direção', 'direcao', DIRECOES),
    seletor('Status', 'status', { em_curso: 'Em curso', atendida: 'Atendida', nao_atendida: 'Não atendida', ocupado: 'Ocupado', falha: 'Falha' }),
    master ? null : campoF('Ramal', 'ramal', { inputmode: 'numeric', placeholder: 'Todos' }),
    campoF('Número ou contato', 'busca', { placeholder: 'Buscar…' }),
    el('button', { class: 'btn', type: 'button', onclick: (e) => acao(e.currentTarget, () => baixar(`${caminho}.csv${qs({ ...estado, pagina: '' })}`, `chamadas-${estado.de}-a-${estado.ate}.csv`)) },
      icone('baixar'), 'Exportar CSV'));

  async function carregar() {
    const r = await api.get(`${caminho}${qs(estado)}`);
    aoAtualizar?.(r);
    resumo.textContent = `${inteiro(r.total)} chamada(s) · ${duracao(r.duracao_s)} faladas · ${dinheiro(r.custo_centavos)} em ligações`;
    const paginas = Math.max(1, Math.ceil(r.total / r.por_pagina));
    limpar(lista,
      tabela(['Início', master ? 'Empresa' : null, 'Direção', 'Origem', 'Destino', master ? null : 'Ramal', 'Status', '>Duração', '>Custo'].filter(Boolean),
        r.itens.map((c) => el('tr', { class: 'clicavel', onclick: () => detalheChamada(c) },
          td(dataHora(c.inicio)), master ? td(c.empresa_nome) : null, td(DIRECOES[c.direcao]),
          td(c.direcao === 'entrada' && c.contato ? [telefone(c.origem), el('div', { class: 'pequeno mudo' }, c.contato)] : telefone(c.origem)),
          td(c.direcao !== 'entrada' && c.contato ? [telefone(c.destino), el('div', { class: 'pequeno mudo' }, c.contato)] : [telefone(c.destino), c.tipo_destino !== 'interno' ? el('div', { class: 'pequeno mudo' }, TIPOS_DESTINO[c.tipo_destino]) : null]),
          master ? null : td(c.ramal ? `${c.ramal} · ${c.ramal_nome}` : '—'),
          td(etiquetaChamada(c.status)), td(c.fim ? duracao(c.duracao_s) : '—', 'dir num'), td(c.custo_centavos ? dinheiro(c.custo_centavos) : '—', 'dir num'))),
        'Nenhuma chamada no período.'),
      paginas > 1 ? el('div', { class: 'paginacao' }, el('span', { class: 'pequeno mudo' }, `Página ${r.pagina} de ${paginas}`), el('div', { class: 'linha' },
        el('button', { class: 'btn pequeno', disabled: r.pagina <= 1, onclick: () => { estado.pagina--; carregar(); } }, 'Anterior'),
        el('button', { class: 'btn pequeno', disabled: r.pagina >= paginas, onclick: () => { estado.pagina++; carregar(); } }, 'Próxima'))) : null);
  }
  limpar(alvo, filtros, cartao(null, el('div', { class: 'linha entre', style: 'margin-bottom:10px' }, resumo), lista));
  return carregar().catch((err) => toast(err.message, true));
}

function detalheChamada(c) {
  const linha = (r, v) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, r), el('strong', { style: 'text-align:right' }, v ?? '—'));
  modal(`Chamada ${DIRECOES[c.direcao].toLowerCase()}`, (fechar) => [
    el('div', { class: 'linha', style: 'margin-bottom:8px' }, etiquetaChamada(c.status), c.campanha ? el('span', { class: 'etiqueta info' }, `Campanha: ${c.campanha}`) : null),
    c.empresa_nome ? linha('Empresa', c.empresa_nome) : null,
    linha('Origem', telefone(c.origem)), linha('Destino', `${telefone(c.destino)} (${TIPOS_DESTINO[c.tipo_destino]})`),
    linha('Ramal', c.ramal ? `${c.ramal} · ${c.ramal_nome}` : null), linha('Contato (CRM)', c.contato),
    linha('Início', dataHora(c.inicio)), linha('Atendida', c.atendida_em ? dataHora(c.atendida_em) : null), linha('Fim', c.fim ? dataHora(c.fim) : 'em curso'),
    linha('Duração falada', duracao(c.duracao_s)), linha('Tempo tarifado', c.tarifado_s ? duracao(c.tarifado_s) : '—'), linha('Custo', dinheiro(c.custo_centavos)),
    linha('Gravação', c.gravacao_bytes ? `${(c.gravacao_bytes / 1048576).toFixed(1)} MB` : 'sem gravação'),
    linha('Identificador', el('span', { class: 'mono pequeno' }, c.uid)),
    el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ]);
}

// ---------- Relatórios ----------
/** Relatório do período (por dia, por tipo de destino e por ramal ou empresa), com exportação. */
export function painelRelatorios(alvo, caminho, { master = false } = {}) {
  const hoje = hojeLocal();
  const estado = { de: somarDias(hoje, -29), ate: hoje };
  const corpo = el('div', { class: 'coluna' });
  const data = (rotulo, k) => {
    const i = el('input', { type: 'date', value: estado[k] });
    i.addEventListener('change', () => { estado[k] = i.value; carregar(); });
    return el('label', { class: 'campo' }, rotulo, i);
  };
  const atalho = (rotulo, dias) => el('button', { class: 'btn', type: 'button', onclick: () => { estado.de = somarDias(hoje, -dias); estado.ate = hoje; desenharFiltros(); carregar(); } }, rotulo);
  const filtros = el('div', { class: 'filtros livre' });
  const desenharFiltros = () => limpar(filtros, data('De', 'de'), data('Até', 'ate'), atalho('Hoje', 0), atalho('7 dias', 6), atalho('30 dias', 29),
    el('button', { class: 'btn', type: 'button', onclick: (e) => acao(e.currentTarget, () => baixar(`${caminho}.csv${qs(estado)}`, `relatorio-${estado.de}-a-${estado.ate}.csv`)) }, icone('baixar'), 'Exportar CSV'),
    el('button', { class: 'btn', type: 'button', onclick: () => print() }, 'Imprimir'));
  desenharFiltros();
  const somas = ['>Chamadas', '>Recebidas', '>Realizadas', '>Atendidas', '>Não atendidas', '>Tempo falado', '>Custo'];
  const celulas = (x) => [td(inteiro(x.chamadas), 'dir num'), td(inteiro(x.recebidas), 'dir num'), td(inteiro(x.realizadas), 'dir num'), td(inteiro(x.atendidas), 'dir num'),
    td(inteiro(x.perdidas), 'dir num'), td(duracao(x.duracao_s), 'dir num'), td(dinheiro(x.custo_centavos), 'dir num')];

  async function carregar() {
    const r = await api.get(`${caminho}${qs(estado)}`);
    const t = r.total;
    const taxa = t.chamadas ? Math.round((t.atendidas / t.chamadas) * 100) : 0;
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador('Chamadas', inteiro(t.chamadas), `${inteiro(t.recebidas)} recebidas · ${inteiro(t.realizadas)} realizadas`, 'chamadas', 'azul'),
        indicador('Atendidas', `${taxa}%`, `${inteiro(t.atendidas)} atendidas · ${inteiro(t.perdidas)} não`, 'ok', 'verde'),
        indicador('Tempo falado', duracao(t.duracao_s), `${minutos(t.tarifado_s)} tarifados`, 'relogio', 'laranja'),
        indicador(master ? 'Faturamento' : 'Custo das ligações', dinheiro(t.custo_centavos), t.realizadas ? `média ${dinheiro(t.custo_centavos / t.realizadas)} por ligação` : null, 'dinheiro', 'roxo')),
      cartao('Chamadas por dia', r.por_dia.length ? barras(r.por_dia.map((d) => ({ rotulo: d.dia, valor: d.chamadas, titulo: `${d.dia.split('-').reverse().join('/')}: ${d.chamadas} chamada(s), ${dinheiro(d.custo_centavos)}` })))
        : el('p', { class: 'mudo' }, 'Sem chamadas no período.')),
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c5' }, cartao('Por tipo de destino', tabela(['Tipo', '>Ligações', '>Minutos', '>Custo'], r.por_tipo.map((x) =>
          el('tr', {}, td(TIPOS_DESTINO[x.tipo_destino]), td(inteiro(x.chamadas), 'dir num'), td(minutos(x.tarifado_s), 'dir num'), td(dinheiro(x.custo_centavos), 'dir num')))),
          'Nenhuma ligação externa.')),
        el('div', { class: 'c7' }, master
          ? cartao('Por empresa', tabela(['Empresa', ...somas], r.por_empresa.map((x) => el('tr', {}, td(x.nome), ...celulas(x))), 'Nenhuma chamada.'))
          : cartao('Por ramal', tabela(['Ramal', ...somas], r.por_ramal.map((x) => el('tr', {}, td(`${x.numero} · ${x.nome}`), ...celulas(x))), 'Nenhuma chamada.')))),
      cartao('Por dia', tabela(['Dia', ...somas], r.por_dia.map((d) => el('tr', {}, td(d.dia.split('-').reverse().join('/')), ...celulas(d))), 'Sem chamadas no período.')));
  }
  limpar(alvo, filtros, corpo);
  return carregar().catch((err) => toast(err.message, true));
}

// ---------- Integrações ----------
/** Chaves da API e a documentação curta para a equipe que cuida da central telefônica. */

export const situacaoDiag = { ok: ['ok', 'OK'], aviso: ['aviso', 'Atenção'], erro: ['erro', 'Problema'] };
