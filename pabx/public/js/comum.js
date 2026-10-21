/** Peças usadas tanto no painel do master quanto no das empresas. */
import { api, baixar, qs, BASE } from './api.js';
import { el, limpar, dinheiro, dataHora, duracao, minutos, inteiro, telefone, etiquetaChamada, DIRECOES, TIPOS_DESTINO, barraUso, toast, acao, campo,
  escolha, hojeLocal, somarDias, modal, formModal, confirmar, icone } from './ui.js';
import { pizza, linhaDoDia, barras, CORES } from './graficos.js';

export const cartao = (titulo, ...conteudo) => el('section', { class: 'cartao' }, titulo ? el('h2', {}, titulo) : null, conteudo);
export const indicador = (rotulo, valor, nota) => el('div', { class: 'cartao indicador' }, el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor num' }, valor),
  nota ? el('div', { class: 'nota' }, nota) : null);
export const td = (conteudo, classe = '') => el('td', { class: classe }, conteudo);
export const tabela = (colunas, linhas, vazio = 'Nada por aqui.') => (linhas.length
  ? el('div', { class: 'rolagem' }, el('table', { class: 'tabela' },
    el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { class: c.startsWith('>') ? 'dir' : c.startsWith('^') ? 'centro' : '' }, c.replace(/^[>^]/, ''))))),
    el('tbody', {}, linhas)))
  : el('p', { class: 'mudo', style: 'margin:0' }, vazio));
export const botao = (texto, classe, fn) => {
  const b = el('button', { class: `btn pequeno ${classe}`, type: 'button' }, texto);
  b.addEventListener('click', () => acao(b, fn));
  return b;
};
export const botaoIcone = (nome, titulo, fn, classe = '') => {
  const b = el('button', { class: `icone-btn ${classe}`, type: 'button', title: titulo, 'aria-label': titulo }, icone(nome));
  b.addEventListener('click', (e) => { e.stopPropagation(); acao(b, fn); });
  return b;
};
export const acoesTopo = (...itens) => el('div', { class: 'linha entre', style: 'margin-bottom:16px' }, ...itens);

// ---------- Dashboard (cartões iguais para o master e para as empresas) ----------
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
export const cartaoRamais = (r) => cartao('Ramais', pizza([{ rotulo: 'Online', valor: r.online, cor: CORES.amarelo }, { rotulo: 'Offline', valor: r.offline, cor: CORES.azul }],
  { vazio: 'Nenhum ramal cadastrado' }));
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
        indicador('Chamadas', inteiro(t.chamadas), `${inteiro(t.recebidas)} recebidas · ${inteiro(t.realizadas)} realizadas`),
        indicador('Atendidas', `${taxa}%`, `${inteiro(t.atendidas)} atendidas · ${inteiro(t.perdidas)} não`),
        indicador('Tempo falado', duracao(t.duracao_s), `${minutos(t.tarifado_s)} tarifados`),
        indicador(master ? 'Faturamento' : 'Custo das ligações', dinheiro(t.custo_centavos), t.realizadas ? `média ${dinheiro(t.custo_centavos / t.realizadas)} por ligação` : null)),
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
export function painelIntegracoes(alvo, { listar, criar, revogar, empresas = null, podeCriar = true }) {
  const lista = el('div');
  const carregar = async () => {
    const chaves = await listar();
    limpar(lista, tabela([empresas ? 'Empresa' : null, 'Nome', 'Chave', 'Criada', 'Último uso', 'Situação', '^Ações'].filter(Boolean), chaves.map((k) => el('tr', {},
      empresas ? td(k.empresa) : null, td(k.nome), td(el('span', { class: 'mono' }, `pbx_${k.prefixo}_…`)), td(dataHora(k.criada_em)), td(dataHora(k.ultimo_uso)),
      td(k.revogada_em ? el('span', { class: 'etiqueta erro' }, 'revogada') : el('span', { class: 'etiqueta ok' }, 'ativa')),
      el('td', { class: 'acoes' }, !k.revogada_em && podeCriar ? botao('Revogar', 'perigo', async () => {
        if (!await confirmar('Revogar chave', `A central telefônica que usa "${k.nome}" perde o acesso na hora. Continuar?`, 'Revogar')) return;
        await revogar(k.id);
        toast('Chave revogada.');
        carregar();
      }) : null))), 'Nenhuma chave criada.'));
  };
  const nova = podeCriar ? el('button', { class: 'btn primario', onclick: async () => {
    const r = await formModal('Nova chave de API', () => [
      empresas ? escolha('Empresa', 'empresa_id', Object.fromEntries(empresas.map((e) => [e.id, e.nome])), empresas[0]?.id, { required: true }) : null,
      campo('Nome (onde será usada)', { name: 'nome', required: true, maxlength: 80, placeholder: 'Ex.: Asterisk principal' }),
    ], (d) => criar(d));
    if (!r || r === true) return;
    carregar();
    modal('Chave criada', (fechar) => [
      el('p', { class: 'mudo' }, 'Copie agora: por segurança, a chave completa não aparece de novo.'),
      el('div', { class: 'segredo' }, r.chave),
      el('div', { class: 'linha entre', style: 'margin-top:14px' },
        el('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(r.chave).then(() => toast('Copiada.'), () => toast('Não foi possível copiar.', true)) }, 'Copiar'),
        el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto')),
    ]);
  } }, 'Nova chave') : null;

  const base = `${location.origin}${BASE}/api/integracao`;
  const doc = cartao('Como ligar a central telefônica',
    el('p', { class: 'mudo', style: 'margin-top:0' }, 'A central telefônica (Asterisk, FreeSWITCH ou outra) usa a chave no cabeçalho X-Api-Key. Ela busca a configuração dos ramais, números, filas e URAs e avisa o painel de cada chamada, do registro dos ramais e do uso de TTS/STT.'),
    el('h3', {}, 'Configuração da empresa'),
    el('pre', { class: 'codigo' }, `GET ${base}/config\nX-Api-Key: pbx_xxxxxxxx_...`),
    el('h3', {}, 'Chamadas (uid = identificador único da chamada na central)'),
    el('pre', { class: 'codigo' }, [
      `POST ${base}/chamadas`,
      '{ "uid": "1729512345.42", "direcao": "saida", "origem": "1001", "destino": "11987654321" }',
      '→ { "id": 10, "gravar": true }   (429 = limite de chamadas simultâneas; 403 = empresa bloqueada)',
      '',
      `POST ${base}/chamadas/1729512345.42/atendida`,
      `POST ${base}/chamadas/1729512345.42/fim`,
      '{ "status": "atendida", "gravacao_bytes": 480000 }   (status: atendida, nao_atendida, ocupado ou falha)',
    ].join('\n')),
    el('h3', {}, 'Ramais, recursos e discador'),
    el('pre', { class: 'codigo' }, [
      `POST ${base}/ramais/1001/registro   { "online": true, "ip": "200.1.2.3", "agente": "Yealink T21" }`,
      `POST ${base}/recursos               { "recurso": "tts", "quantidade": 1 }`,
      `POST ${base}/campanhas/5/proximos   → contatos a discar (use "campanha_contato_id" no início da chamada)`,
    ].join('\n')));
  limpar(alvo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Chaves que a central telefônica usa para conversar com o painel.'), nova), cartao(null, lista),
    el('div', { style: 'height:18px' }), doc);
  return carregar().catch((err) => toast(err.message, true));
}

export const situacaoDiag = { ok: ['ok', 'OK'], aviso: ['aviso', 'Atenção'], erro: ['erro', 'Problema'] };
