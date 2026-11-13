/** Peças usadas no painel do master e no das empresas. */
import { api, baixar, qs } from './api.js';
import {
  el, limpar, icone, acao, inteiro, duracao, dataHora, porcento, dinheiro, estrelas, desde, espera,
  etiquetaEstado, RESOLVIDA_POR, escolha, campo, hojeLocal, somarDias, toast,
} from './ui.js';
import { pizza, linhaDoDia, barras, CORES } from './graficos.js';

export const cartao = (titulo, ...conteudo) => el('section', { class: 'cartao' }, titulo ? el('h2', {}, titulo) : null, conteudo);

/** Número em destaque: ícone colorido, valor, rótulo e uma nota. Cores: azul, verde, roxo, laranja, vermelho, ciano. */
export const indicador = (rotulo, valor, nota, ic = null, cor = 'azul') => el('div', { class: `cartao indicador${ic ? ' com-icone' : ''}` },
  ic ? el('div', { class: `ic ${cor}` }, icone(ic)) : null,
  el('div', { class: 'corpo' }, el('div', { class: 'valor num' }, valor), el('div', { class: 'rotulo' }, rotulo), nota ? el('div', { class: 'nota' }, nota) : null));

export const td = (conteudo, classe = '') => el('td', { class: classe }, conteudo);

export const tabela = (colunas, linhas, vazio = 'Nada por aqui.') => (linhas.length
  ? el('div', { class: 'rolagem' }, el('table', { class: 'tabela' },
    el('thead', {}, el('tr', {}, colunas.filter(Boolean).map((c) => el('th', { class: c.startsWith('>') ? 'dir' : c.startsWith('^') ? 'centro' : '' }, c.replace(/^[>^]/, ''))))),
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

export const vazio = (texto, sub = null) => el('div', { class: 'vazio' }, icone('caixa'), el('p', {}, texto), sub ? el('small', {}, sub) : null);

// ---------- Indicadores do atendimento ----------

/**
 * Os quatro números que contam a história: quanto a ZOE resolveu sozinha,
 * quanto foi para a equipe, quanto tempo o cliente esperou e como ele avaliou.
 */
export function indicadoresAtendimento(r) {
  const resolvidas = r.resolvidas_ia + r.resolvidas_cliente;
  return [
    indicador('Resolvidas pela ZOE', porcento(r.taxa_resolucao_ia),
      `${inteiro(resolvidas)} de ${inteiro(r.encerradas)} encerradas`, 'robo', 'verde'),
    indicador('Conversas', inteiro(r.conversas), `${inteiro(r.em_aberto)} em aberto agora`, 'conversa', 'azul'),
    indicador('Foram para a equipe', inteiro(r.transferidas), `${porcento(r.taxa_transferencia)} do total`, 'pessoa', 'laranja'),
    indicador('Satisfação (CSAT)', r.csat_medio === null ? '—' : r.csat_medio.toLocaleString('pt-BR'),
      r.avaliacoes ? `${inteiro(r.avaliacoes)} avaliação(ões) · ${porcento(r.csat_satisfacao)} boas` : 'sem avaliações', 'estrela', 'roxo'),
  ];
}

/** Como as conversas terminaram. */
export const cartaoDesfechos = (r) => cartao('Como terminaram', pizza([
  { rotulo: 'Resolvidas pela ZOE', valor: r.resolvidas_ia, cor: CORES.verde },
  { rotulo: 'Cliente se despediu', valor: r.resolvidas_cliente, cor: CORES.ciano },
  { rotulo: 'Resolvidas pela equipe', valor: r.resolvidas_humano, cor: CORES.azul },
  { rotulo: 'Cliente parou de responder', valor: r.abandonadas, cor: CORES.cinza },
], { vazio: 'Nenhuma conversa encerrada no período', centro: { valor: inteiro(r.encerradas), rotulo: 'encerradas' }, lado: true }));

/** Tempos: primeira resposta, espera na fila e duração. */
export function cartaoTempos(r) {
  const linha = (rotulo, valor, nota) => el('tr', {}, el('td', {}, rotulo, nota ? el('div', { class: 'pequeno mudo' }, nota) : null), td(valor === null ? '—' : duracao(valor), 'dir num'));
  return cartao('Tempos médios', el('table', { class: 'tabela tabela-utilizacao' }, el('tbody', {},
    linha('Primeira resposta', r.primeira_resposta_s, 'a ZOE responde na hora'),
    linha('Espera na fila', r.espera_fila_s, 'da transferência até um atendente assumir'),
    linha('Duração do atendimento', r.duracao_s, 'da primeira à última mensagem'),
    linha('Quando a ZOE resolve', r.duracao_ia_s, 'sem ocupar ninguém da equipe'))));
}

/** Volume por dia: conversas, resolvidas pela IA e transferidas. */
export function cartaoPorDia(serie) {
  const max = Math.max(1, ...serie.map((d) => d.conversas));
  return cartao('Conversas por dia', el('div', { class: 'serie-dias' }, serie.map((d) => el('div', {
    class: 'coluna-dia',
    title: `${new Date(`${d.data}T12:00:00`).toLocaleDateString('pt-BR')}: ${d.conversas} conversa(s), ${d.resolvidas_ia} resolvida(s) pela IA, ${d.transferidas} transferida(s)`,
  },
  el('div', { class: 'pilha' },
    el('span', { class: 'ia', style: `height:${(d.resolvidas_ia / max) * 100}%` }),
    el('span', { class: 'humano', style: `height:${(d.transferidas / max) * 100}%` })),
  el('small', {}, d.data.slice(8))))),
  el('div', { class: 'legenda', style: 'margin-top:10px' },
    el('span', {}, el('i', { style: `background:${CORES.verde}` }), 'Resolvidas pela ZOE'),
    el('span', {}, el('i', { style: `background:${CORES.azul}` }), 'Transferidas para a equipe')));
}

/** Conversas por hora do dia: mostra quando é preciso ter gente de plantão. */
export const cartaoPorHora = (horas) => cartao('Movimento por hora',
  barras(horas.map((h) => ({ rotulo: `${h.hora}h`, valor: h.conversas, titulo: `${String(h.hora).padStart(2, '0')}h: ${h.conversas} conversa(s)` }))),
  el('div', { class: 'pequeno mudo', style: 'display:flex;justify-content:space-between;margin-top:6px' },
    el('span', {}, '00h'), el('span', {}, '06h'), el('span', {}, '12h'), el('span', {}, '18h'), el('span', {}, '23h')));

/** Por que a ZOE transferiu: a lista de onde a base de conhecimento está faltando. */
export const cartaoMotivos = (motivos) => cartao('Por que foi para a equipe',
  tabela(['Motivo', 'Fila', '>Conversas'], motivos.map((m) => el('tr', {},
    td(m.motivo), td(m.fila), td(inteiro(m.conversas), 'dir num'))), 'Nenhuma transferência no período'),
  motivos.length ? el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
    'Motivo que se repete é oportunidade: um artigo novo na base de conhecimento faz a ZOE resolver isso sozinha.') : null);

/** Custo e uso da IA no período. */
export function cartaoCustoIa(ia) {
  const linha = (rotulo, valor) => el('tr', {}, el('td', {}, rotulo), td(valor, 'dir num'));
  return cartao('ZOE no período', el('table', { class: 'tabela tabela-utilizacao' }, el('tbody', {},
    linha('Respostas geradas', inteiro(ia.respostas)),
    linha('Ferramentas usadas', inteiro(ia.ferramentas)),
    linha('Tempo médio da resposta', ia.ms_medio === null ? '—' : `${inteiro(ia.ms_medio)} ms`),
    linha('Tokens de entrada', inteiro(ia.tokens_entrada)),
    linha('Tokens lidos do cache', inteiro(ia.tokens_cache)),
    linha('Tokens de saída', inteiro(ia.tokens_saida)),
    linha('Custo estimado', dinheiro(ia.custo_centavos)),
    ia.erros ? linha('Falhas da ZOE', inteiro(ia.erros)) : null)),
  el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
    'Custo estimado pelos preços cadastrados pelo master em Configurações. Toda conversa transferida que a IA passar a resolver sozinha sai bem mais barata que um atendimento humano.'));
}

// ---------- Filtro de período ----------

/** Filtro De/Até com atalhos. Chama `aoMudar({ de, ate })`. */
export function filtroPeriodo(estado, aoMudar, extras = []) {
  const hoje = hojeLocal();
  const campoData = (rotulo, nome) => {
    const i = el('input', { type: 'date', value: estado[nome], max: hoje });
    i.addEventListener('change', () => { estado[nome] = i.value; aoMudar(estado); });
    return el('label', { class: 'campo' }, rotulo, i);
  };
  const atalho = (rotulo, dias) => el('button', { class: 'btn pequeno', type: 'button', onclick: () => {
    estado.de = dias === 0 ? hoje : somarDias(hoje, -dias);
    estado.ate = hoje;
    aoMudar(estado);
  } }, rotulo);
  return el('div', { class: 'filtros livre' },
    campoData('De', 'de'), campoData('Até', 'ate'),
    el('div', { class: 'linha', style: 'gap:6px;align-items:flex-end' }, atalho('Hoje', 0), atalho('7 dias', 6), atalho('30 dias', 29)),
    ...extras);
}

/** Seletor que recarrega a tela ao mudar. */
export function seletor(rotulo, opcoes, valor, aoMudar) {
  const s = escolha(null, 'f', opcoes, valor);
  s.addEventListener('change', () => aoMudar(s.value));
  return el('label', { class: 'campo' }, rotulo, s);
}

/** Campo de busca com atraso (não dispara a cada tecla). */
export function campoBusca(valor, aoBuscar, placeholder = 'Buscar…') {
  const i = el('input', { value: valor ?? '', placeholder, type: 'search' });
  let timer;
  i.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => aoBuscar(i.value.trim()), 350); });
  return el('label', { class: 'campo' }, 'Buscar', i);
}

// ---------- Tela de relatórios (igual para o master e para a empresa) ----------

/**
 * Desenha a tela de relatórios. `caminho`: '/master/relatorios' ou '/empresas/ID/relatorios'.
 * `extras(dados)` acrescenta cartões específicos de cada painel.
 */
export function telaRelatorios(ctx, caminho, { extras = () => [], comCsv = null } = {}) {
  const hoje = hojeLocal();
  const estado = { de: somarDias(hoje, -29), ate: hoje };
  const conteudo = el('div');
  const desenhar = async () => {
    const d = await api.get(`${caminho}${qs(estado)}`);
    limpar(conteudo,
      el('div', { class: 'indicadores' }, indicadoresAtendimento(d.resumo)),
      el('div', { class: 'grade-2' }, cartaoDesfechos(d.resumo), cartaoTempos(d.resumo)),
      cartaoPorDia(d.por_dia),
      el('div', { class: 'grade-2' }, cartaoPorHora(d.por_hora), cartaoCustoIa(d.resumo.ia)),
      ...extras(d),
      cartaoMotivos(d.motivos));
  };
  limpar(ctx.conteudo,
    filtroPeriodo(estado, () => { desenhar().catch((e) => toast(e.message, true)); },
      comCsv ? [el('button', { class: 'btn', type: 'button', style: 'align-self:flex-end', onclick: (e) => acao(e.currentTarget, () => baixar(`${comCsv}${qs(estado)}`, `conversas-${estado.de}-a-${estado.ate}.csv`)) }, icone('baixar'), 'Exportar CSV')] : []),
    conteudo);
  return desenhar();
}

export { pizza, linhaDoDia, barras, CORES, etiquetaEstado, RESOLVIDA_POR, estrelas, desde, espera, dataHora, campo };
