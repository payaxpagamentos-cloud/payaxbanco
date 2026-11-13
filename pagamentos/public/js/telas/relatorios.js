import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, kpi, campo, lerForm, acao, dinheiro, numero, percentual, data,
  documento, hojeIso, primeiroDiaMes, icone
} from '../../comum/ui.js';
import { barrasPorDia, barraSplit } from '../../comum/graficos.js';

/** Faturamento da plataforma: quanto entrou por cliente, quanto ficou conosco e qual a margem. */
export default async function relatorios({ alvo, query }) {
  const p = { de: query.de ?? primeiroDiaMes(), ate: query.ate ?? hojeIso() };
  const d = await api.get(`/relatorios/faturamento${qs(p)}`);
  const t = d.totais;
  const temMargem = t.margem_centavos !== undefined && t.margem_centavos !== null;

  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/relatorios${qs(lerForm(form))}`); } },
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: p.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: p.ate }),
    el('button', { class: 'botao', type: 'submit' }, 'Aplicar'),
    el('button', { class: 'botao sec', type: 'button', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/relatorios/faturamento.csv${qs(p)}`, `faturamento-${p.de}-a-${p.ate}.csv`)) }, icone('baixar'), 'CSV'),
    el('button', { class: 'botao sec', type: 'button', onclick: () => window.print() }, icone('imprimir'), 'Imprimir'));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Relatórios'),
      el('p', {}, `Faturamento de ${data(p.de)} a ${data(p.ate)}`))),
    form,
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Recebido (bruto)', valor: dinheiro(t.bruto_centavos), apoio: `${numero(t.liquidados)} título(s) liquidado(s)`, tom: 'destaque', ic: 'dinheiro' }),
      kpi({ rotulo: 'Nossa receita', valor: dinheiro(t.receita_centavos), apoio: `tarifa PAY AX ${dinheiro(t.comissao_centavos)} + tarifas bancárias ${dinheiro(t.tarifas_centavos)}`, tom: 'positivo', ic: 'relatorio' }),
      temMargem ? kpi({ rotulo: 'Margem', valor: dinheiro(t.margem_centavos), apoio: `custo do banco ${dinheiro(t.custo_banco_centavos)}`, ic: 'banco' }) : null,
      kpi({ rotulo: 'Repassado aos clientes', valor: dinheiro(t.repassado_centavos), menor: true, ic: 'troca' }),
      kpi({ rotulo: 'Conversão', valor: d.taxa_conversao === null ? '—' : `${numero(d.taxa_conversao, 1)}%`, apoio: `${numero(t.emitidos)} emitidos no período`, menor: true, ic: 'ok' })),

    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('Entradas por dia', barrasPorDia({ dados: d.serie.map((s) => ({ data: s.data, valor: s.bruto_centavos, titulos: s.titulos })) })),
      cartao('Divisão do recebido', t.bruto_centavos ? barraSplit({
        total: t.bruto_centavos,
        partes: [
          { rotulo: 'Líquido dos clientes', valor: t.bruto_centavos - t.comissao_centavos - t.tarifas_centavos },
          { rotulo: 'Tarifas', valor: t.tarifas_centavos },
          { rotulo: 'Tarifa PAY AX', valor: t.comissao_centavos },
        ],
      }) : el('p', { class: 'vazio' }, 'Nada liquidado no período.'))),

    el('div', { style: 'margin-top:14px' }, cartao('Por cliente', tabela({
      colunas: [
        { titulo: 'Cliente', conteudo: (c) => el('span', {}, el('span', { class: 'forte' }, c.nome_fantasia || c.razao_social), el('span', { class: 'sub' }, documento(c.cnpj))) },
        { titulo: 'Emitidos', dir: true, conteudo: (c) => el('span', {}, numero(c.emitidos), el('span', { class: 'sub' }, dinheiro(c.valor_emitido_centavos))) },
        { titulo: 'Liquidados', dir: true, conteudo: (c) => el('span', {}, numero(c.liquidados), el('span', { class: 'sub' }, dinheiro(c.bruto_centavos))) },
        { titulo: 'Tarifa PAY AX', dir: true, conteudo: (c) => dinheiro(c.comissao_centavos) },
        { titulo: 'Tarifas', dir: true, conteudo: (c) => dinheiro(c.tarifas_centavos) },
        { titulo: 'Receita', dir: true, conteudo: (c) => el('strong', {}, dinheiro(c.receita_centavos)) },
        ...(temMargem ? [{ titulo: 'Margem', dir: true, conteudo: (c) => dinheiro(c.margem_centavos) }] : []),
        { titulo: 'Repassado', dir: true, conteudo: (c) => dinheiro(c.repassado_centavos) },
      ],
      itens: d.clientes.filter((c) => c.emitidos || c.liquidados),
      vazio: 'Nenhum movimento no período.',
      aoClicar: pode('clientes.ver') ? (c) => ir(`#/clientes/${c.id}`) : null,
    }))),
  );
}
