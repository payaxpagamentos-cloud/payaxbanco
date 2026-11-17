import { el, acao, icone } from './ui.js';

/** Peças comuns às telas do painel. */
export const cabeca = (titulo, ...acoes) => el('div', { class: 'cabeca' },
  el('h1', { style: 'margin:0' }, titulo), el('div', { class: 'linha' }, acoes));

export const indicador = (rotulo, valor, nota, destaque = false) => el('div', { class: `cartao indicador${destaque ? ' destaque' : ''}` },
  el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor num' }, valor), nota ? el('div', { class: 'nota' }, nota) : null);

export const tabela = (colunas, linhas, vazio = 'Nada por aqui.') => (linhas.length
  ? el('div', { class: 'cartao rolagem', style: 'padding:0' }, el('table', { class: 'tabela' },
    el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { class: c.startsWith('>') ? 'dir' : '' }, c.replace(/^>/, ''))))),
    el('tbody', {}, linhas)))
  : el('div', { class: 'cartao vazio' }, vazio));

export const td = (conteudo, dir = false) => el('td', { class: dir ? 'dir num' : '' }, conteudo);

/** Botão que já trata erro e evita duplo clique. */
export const botao = (texto, classe, fn, nomeIcone = null) => {
  const b = el('button', { class: `btn pequeno ${classe}` }, nomeIcone ? icone(nomeIcone) : null, texto);
  b.addEventListener('click', () => acao(b, fn));
  return b;
};

export const campo = (rotulo, attrs = {}, dica = null) => el('label', { class: 'campo' }, rotulo,
  el('input', attrs), dica ? el('span', { class: 'mini apagado' }, dica) : null);

export const area = (rotulo, attrs = {}) => el('label', { class: 'campo' }, rotulo, el('textarea', attrs));

export const escolha = (rotulo, nome, opcoes, valor, extra = {}) => el('label', { class: 'campo' }, rotulo,
  el('select', { name: nome, ...extra }, opcoes.map(([v, r]) => el('option', { value: v, ...(String(v) === String(valor) ? { selected: true } : {}) }, r))));

export const caixaSim = (rotulo, nome, ligado) => el('label', { class: 'campo linha-campo' },
  el('input', { type: 'checkbox', name: nome, ...(ligado ? { checked: true } : {}) }), rotulo);

export const CLASSIFICACOES_OPCOES = [[0, 'Livre'], [10, '10 anos'], [12, '12 anos'], [14, '14 anos'], [16, '16 anos'], [18, '18 anos']];

/** Gráfico de barras simples (audiência por dia ou por hora). */
export function barras(dados, { valor = (d) => d.minutos, rotulo = (d) => d.dia, unidade = 'min' } = {}) {
  const maximo = Math.max(1, ...dados.map(valor));
  return el('div', { class: 'cartao' }, el('div', { class: 'barras' }, dados.map((d) => el('div', {
    class: 'barra',
    style: `height:${Math.max(2, (valor(d) / maximo) * 100)}%`,
    title: `${rotulo(d)}: ${valor(d)} ${unidade}`,
  }))), el('div', { class: 'linha entre mini apagado', style: 'margin-top:8px' },
    el('span', {}, dados.length ? rotulo(dados[0]) : ''),
    el('span', {}, `máximo ${maximo} ${unidade}`),
    el('span', {}, dados.length ? rotulo(dados.at(-1)) : '')));
}
