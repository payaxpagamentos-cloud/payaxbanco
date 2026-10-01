import { api } from '../api.js';
import { html, $, debounce, documento, moeda, TIPO_CONTA } from '../ui.js';

/** HTML de um seletor com busca. Use ligarSeletor() após renderizar. */
export const seletor = (nome, rotulo, placeholder) => html`
  <label>${rotulo}</label>
  <div data-seletor="${nome}" class="stack" style="gap:6px">
    <input type="search" placeholder="${placeholder}" data-busca autocomplete="off">
    <select name="${nome}" required size="4" style="height:auto;padding:4px"></select>
  </div>`;

const OPCOES = {
  conta: {
    buscar: (q) => api.get('/contas', { q, status: 'ativa', limite: 15 }).then((r) => r.itens),
    rotulo: (c) => `${c.numero}-${c.digito} · ${c.cliente_nome} · ${TIPO_CONTA[c.tipo]} · ${moeda(c.saldo_centavos)}`,
  },
  contaQualquer: {
    buscar: (q) => api.get('/contas', { q, limite: 15 }).then((r) => r.itens.filter((c) => c.status !== 'encerrada')),
    rotulo: (c) => `${c.numero}-${c.digito} · ${c.cliente_nome} · ${TIPO_CONTA[c.tipo]}`,
  },
  cliente: {
    buscar: (q) => api.get('/clientes', { q, status: 'ativo', limite: 15 }).then((r) => r.itens),
    rotulo: (c) => `${c.nome} · ${documento(c.documento)}`,
  },
};

/**
 * Liga o seletor `nome` dentro de `raiz` ao tipo de busca informado.
 * `aoSelecionar(item)` é chamado quando o usuário escolhe uma opção.
 */
export function ligarSeletor(raiz, nome, tipo, { inicial, aoSelecionar } = {}) {
  const caixa = $(`[data-seletor="${nome}"]`, raiz);
  const busca = $('[data-busca]', caixa);
  const lista = $('select', caixa);
  const cfg = OPCOES[tipo];
  let itens = [];
  const preencher = (novos) => {
    itens = novos;
    lista.innerHTML = itens.length
      ? itens.map((i) => String(html`<option value="${i.id}">${cfg.rotulo(i)}</option>`)).join('')
      : String(html`<option value="" disabled>Nenhum resultado</option>`);
    if (itens.length === 1) { lista.value = String(itens[0].id); aoSelecionar?.(itens[0]); }
  };
  if (inicial) {
    preencher([inicial]);
  } else {
    cfg.buscar('').then(preencher).catch(() => preencher([]));
  }
  busca.addEventListener('input', debounce(() => cfg.buscar(busca.value).then(preencher)));
  lista.addEventListener('change', () => aoSelecionar?.(itens.find((i) => String(i.id) === lista.value)));
}
