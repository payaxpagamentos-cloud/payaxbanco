import { api, ir } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, kpi, campo, lerForm, acao, dinheiro, numero, data,
  hojeIso, primeiroDiaMes, icone, aviso
} from '../../comum/ui.js';
import { agendaLiberacao } from '../../comum/graficos.js';

/** Extrato da conta: cada crédito, cada desconto e cada repasse, com saldo acumulado. */
export default async function extrato({ alvo, query }) {
  const p = { de: query.de ?? primeiroDiaMes(), ate: query.ate ?? hojeIso(), tipo: query.tipo ?? '' };
  const [e, conta] = await Promise.all([api.get(`/conta/extrato${qs(p)}`), api.get('/conta')]);

  const form = el('form', { class: 'filtros', onsubmit: (ev) => { ev.preventDefault(); ir(`#/extrato${qs(lerForm(form))}`); } },
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: p.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: p.ate }),
    campo({ nome: 'tipo', rotulo: 'Tipo', tipo: 'select', valor: p.tipo, opcoes: [
      ['', 'Todos'], ['credito_liquidacao', 'Recebimentos'], ['tarifa_banco', 'Tarifas bancárias'],
      ['comissao', 'Comissão PayAx'], ['tarifa_emissao', 'Tarifas de emissão'], ['repasse', 'Repasses'],
      ['estorno', 'Estornos'], ['ajuste', 'Ajustes']] }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'),
    el('button', { class: 'botao sec', type: 'button', onclick: (ev) => acao(ev.currentTarget, () => api.baixar(`/conta/extrato.csv${qs(p)}`, `extrato-${p.de}-a-${p.ate}.csv`)) }, icone('baixar'), 'CSV'),
    el('button', { class: 'botao sec', type: 'button', onclick: () => window.print() }, icone('imprimir'), 'Imprimir'));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Extrato'),
      el('p', {}, 'Tudo que entrou, o que foi descontado e o que já foi transferido para você.'))),
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Saldo disponível', valor: dinheiro(e.saldo.disponivel_centavos), tom: 'destaque', ic: 'cofre' }),
      kpi({ rotulo: 'A liberar', valor: dinheiro(e.saldo.a_liberar_centavos), apoio: `retenção de D+${conta.retencao_dias} dia útil`, menor: true, ic: 'relogio' }),
      kpi({ rotulo: 'Saldo total', valor: dinheiro(e.saldo.total_centavos), menor: true }),
      kpi({ rotulo: 'Movimento do período', valor: dinheiro(e.soma_centavos), apoio: `${numero(e.total)} lançamento(s)`, menor: true })),
    el('div', { style: 'margin-top:14px' }, form),
    tabela({
      colunas: [
        { titulo: 'Data', conteudo: (l) => data(l.data_competencia) },
        { titulo: 'Lançamento', conteudo: (l) => el('span', {}, el('span', { class: 'forte' }, l.tipo_nome), el('span', { class: 'sub' }, l.descricao)) },
        { titulo: 'Liberação', conteudo: (l) => el('span', {}, data(l.data_liberacao),
          l.data_liberacao > hojeIso() ? el('span', { class: 'sub' }, 'ainda a liberar') : null) },
        { titulo: 'Valor', dir: true, conteudo: (l) => el('strong', { style: l.valor_centavos < 0 ? 'color:var(--vermelho)' : 'color:var(--verde-texto)' }, dinheiro(l.valor_centavos)) },
        { titulo: 'Saldo', dir: true, conteudo: (l) => dinheiro(l.saldo_acumulado_centavos) },
      ],
      itens: e.itens,
      vazio: 'Nenhum lançamento no período.',
      aoClicar: (l) => (l.boleto_id ? ir(`#/boletos/${l.boleto_id}`) : null),
    }),
    el('div', { style: 'margin-top:14px' }, cartao('Quando o saldo retido é liberado', agendaLiberacao({ dados: conta.agenda }))),
  );
}
