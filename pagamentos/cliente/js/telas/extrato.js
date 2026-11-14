import { api, ir } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, campo, lerForm, acao, dinheiro, numero, data,
  hojeIso, primeiroDiaMes, icone, aviso,
} from '../../comum/ui.js';
import { agendaLiberacao } from '../../comum/graficos.js';
import { cartaoConta, linhaTempo } from '../../comum/componentes.js';

const CHAVE_VISAO = 'payax.extrato.visao';
const visaoGuardada = () => { try { return localStorage.getItem(CHAVE_VISAO) || 'tempo'; } catch { return 'tempo'; } };

/** Extrato: linha do tempo por padrão, tabela para quem precisa conferir lançamento a lançamento. */
export default async function extrato({ alvo, query, recarregar }) {
  const p = { de: query.de ?? primeiroDiaMes(), ate: query.ate ?? hojeIso(), tipo: query.tipo ?? '' };
  const [e, conta] = await Promise.all([api.get(`/conta/extrato${qs(p)}`), api.get('/conta')]);
  const hoje = hojeIso();
  let visao = query.visao ?? visaoGuardada();

  const form = el('form', { class: 'filtros', onsubmit: (ev) => { ev.preventDefault(); ir(`#/extrato${qs({ ...lerForm(form), visao })}`); } },
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: p.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: p.ate }),
    campo({ nome: 'tipo', rotulo: 'Mostrar', tipo: 'select', valor: p.tipo, opcoes: [
      ['', 'Tudo'], ['credito_liquidacao', 'Só recebimentos'], ['repasse', 'Só transferências'],
      ['comissao', 'Tarifa PAY AX'], ['tarifa_banco', 'Tarifas bancárias'], ['tarifa_emissao', 'Tarifas de emissão'],
      ['estorno', 'Estornos'], ['ajuste', 'Ajustes']] }),
    el('button', { class: 'botao', type: 'submit' }, icone('busca'), 'Filtrar'),
    el('button', { class: 'botao sec', type: 'button', onclick: (ev) => acao(ev.currentTarget, () => api.baixar(`/conta/extrato.csv${qs(p)}`, `extrato-${p.de}-a-${p.ate}.csv`)) }, icone('baixar'), 'CSV'),
    el('button', { class: 'botao sec', type: 'button', onclick: () => window.print() }, icone('imprimir'), 'Imprimir'));

  const corpo = el('div', {});
  const alternar = (nova) => {
    visao = nova;
    try { localStorage.setItem(CHAVE_VISAO, nova); } catch { /* sem armazenamento */ }
    desenhar();
  };

  const desenhar = () => {
    corpo.replaceChildren(visao === 'tabela' ? comoTabela(e, hoje) : comoTempo(e, hoje));
    for (const b of abas.querySelectorAll('button')) b.classList.toggle('ativa', b.dataset.visao === visao);
  };
  const abas = el('div', { class: 'abas' },
    el('button', { dataset: { visao: 'tempo' }, onclick: () => alternar('tempo') }, 'Linha do tempo'),
    el('button', { dataset: { visao: 'tabela' }, onclick: () => alternar('tabela') }, 'Lançamento a lançamento'));

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Extrato'),
        el('p', {}, `De ${data(p.de)} a ${data(p.ate)} · ${numero(e.total)} lançamento(s)`))),

    cartaoConta({ transferencias: conta.transferencias, codigo: conta.codigo }),

    el('div', { style: 'margin-top:18px' }, form),
    abas,
    corpo,
    conta.agenda?.length
      ? el('div', { style: 'margin-top:18px' }, cartao('Quando o saldo retido é liberado', agendaLiberacao({ dados: conta.agenda })))
      : null,
  );
  desenhar();
}

const comoTempo = (e, hoje) => (e.itens.length
  ? linhaTempo({
    lancamentos: [...e.itens].reverse(),
    hoje,
    aoAbrirBoleto: (id) => ir(`#/boletos/${id}`),
    vazio: 'Nenhum movimento no período.',
  })
  : aviso('Nenhum movimento no período escolhido. Experimente ampliar as datas.', 'info'));

const comoTabela = (e, hoje) => tabela({
  colunas: [
    { titulo: 'Data', conteudo: (l) => data(l.data_competencia) },
    { titulo: 'Lançamento', conteudo: (l) => el('span', {}, el('span', { class: 'forte' }, l.tipo_nome), el('span', { class: 'sub' }, l.descricao)) },
    { titulo: 'Liberação', conteudo: (l) => el('span', {}, data(l.data_liberacao),
      l.data_liberacao > hoje ? el('span', { class: 'sub' }, 'ainda retido') : null) },
    { titulo: 'Valor', dir: true, conteudo: (l) => el('strong', { style: l.valor_centavos < 0 ? 'color:var(--vermelho)' : 'color:#0a6b45' }, dinheiro(l.valor_centavos)) },
    { titulo: 'Saldo', dir: true, conteudo: (l) => dinheiro(l.saldo_acumulado_centavos) },
  ],
  itens: e.itens,
  vazio: 'Nenhum lançamento no período.',
  aoClicar: (l) => (l.boleto_id ? ir(`#/boletos/${l.boleto_id}`) : null),
});
