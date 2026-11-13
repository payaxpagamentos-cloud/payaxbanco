import { api, ir } from '../app.js';
import { qs } from '../../comum/api.js';
import { el, cartao, tabela, kpi, campo, lerForm, selo, dinheiro, numero, dataHora, data,
  hojeIso, primeiroDiaMes, aviso, icone } from '../../comum/ui.js';

/** Avisos do banco e o que o sistema fez com cada um. */
export default async function conciliacao({ alvo, query }) {
  const p = { de: query.de ?? primeiroDiaMes(), ate: query.ate ?? hojeIso() };
  const d = await api.get(`/relatorios/conciliacao${qs(p)}`);
  const resumo = Object.fromEntries(d.resumo.map((r) => [r.resultado, r.n]));
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/conciliacao${qs(lerForm(form))}`); } },
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: p.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: p.ate }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'));

  const tom = { liquidado: 'ok', repetido: 'info', ignorado: 'neutra', erro: 'erro', pendente: 'aviso' };

  alvo.append(
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Conciliação'),
      el('p', {}, 'Cada aviso do banco é guardado antes de ser processado — nada se perde se algo falhar.'))),
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Liquidados pelo aviso', valor: numero(resumo.liquidado ?? 0), tom: 'positivo', ic: 'ok' }),
      kpi({ rotulo: 'Avisos repetidos', valor: numero(resumo.repetido ?? 0), apoio: 'já estavam liquidados', menor: true, ic: 'atualizar' }),
      kpi({ rotulo: 'Ignorados', valor: numero(resumo.ignorado ?? 0), apoio: 'sem título correspondente', menor: true, ic: 'info' }),
      kpi({ rotulo: 'Com erro', valor: numero(resumo.erro ?? 0), menor: true, tom: (resumo.erro ?? 0) ? 'negativo' : '', ic: 'alerta' })),
    el('div', { style: 'margin-top:14px' }, form),
    d.sem_aviso ? aviso(`${d.sem_aviso} título(s) vencidos continuam em aberto. Se algum já foi pago, use "Consultar no banco" na ficha do boleto.`, 'aviso') : null,
    el('div', { style: 'margin-top:14px' }, tabela({
      colunas: [
        { titulo: 'Recebido', conteudo: (e) => dataHora(e.recebido_em) },
        { titulo: 'Evento', conteudo: (e) => el('span', {}, e.tipo, el('span', { class: 'sub' }, e.origem)) },
        { titulo: 'Nosso número', conteudo: (e) => el('span', { class: 'num' }, e.nosso_numero ?? '—') },
        { titulo: 'Título', conteudo: (e) => (e.boleto_id ? el('span', {}, e.pagador_nome, el('span', { class: 'sub' }, e.razao_social)) : '—') },
        { titulo: 'Valor', dir: true, conteudo: (e) => (e.valor_centavos ? dinheiro(e.valor_centavos) : '—') },
        { titulo: 'Resultado', conteudo: (e) => el('span', {}, el('span', { class: `selo ${tom[e.resultado ?? 'pendente'] ?? 'neutra'}` }, e.resultado ?? 'pendente'),
          e.erro ? el('span', { class: 'sub' }, e.erro) : null) },
      ],
      itens: d.eventos,
      vazio: 'Nenhum aviso recebido no período.',
      aoClicar: (e) => (e.boleto_id ? ir(`#/boletos/${e.boleto_id}`) : null),
    })),
  );
}
