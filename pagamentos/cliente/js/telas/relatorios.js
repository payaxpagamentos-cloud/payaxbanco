import { api, ir } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, kpi, campo, lerForm, acao, dinheiro, numero, percentual, data,
  hojeIso, primeiroDiaMes, icone
} from '../../comum/ui.js';
import { barrasPorDia, barraSplit } from '../../comum/graficos.js';

/** Resumo do período: emitido, recebido, descontado e repassado. */
export default async function relatorios({ alvo, query }) {
  const p = { de: query.de ?? primeiroDiaMes(), ate: query.ate ?? hojeIso() };
  const d = await api.get(`/painel${qs(p)}`);
  const l = d.liquidacoes;
  const b = d.boletos;

  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/relatorios${qs(lerForm(form))}`); } },
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: p.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: p.ate }),
    el('button', { class: 'botao', type: 'submit' }, 'Aplicar'),
    el('button', { class: 'botao sec', type: 'button', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/boletos/export.csv${qs({ ...p, campo_data: 'emissao', por_pagina: 10000 })}`, `boletos-${p.de}-a-${p.ate}.csv`)) }, icone('baixar'), 'Boletos em CSV'),
    el('button', { class: 'botao sec', type: 'button', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/conta/extrato.csv${qs(p)}`, `extrato-${p.de}-a-${p.ate}.csv`)) }, icone('baixar'), 'Extrato em CSV'),
    el('button', { class: 'botao sec', type: 'button', onclick: () => window.print() }, icone('imprimir'), 'Imprimir'));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Relatórios'),
      el('p', {}, `De ${data(p.de)} a ${data(p.ate)}`))),
    form,
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Boletos emitidos', valor: numero(b.emitidos), apoio: dinheiro(b.valor_emitido_centavos), ic: 'boleto' }),
      kpi({ rotulo: 'Recebido', valor: dinheiro(l.bruto_centavos), apoio: `${numero(l.titulos)} título(s) pago(s)`, tom: 'destaque', ic: 'dinheiro' }),
      kpi({ rotulo: 'Líquido para você', valor: dinheiro(l.liquido_centavos), tom: 'positivo', ic: 'cofre' }),
      kpi({ rotulo: 'Descontos', valor: dinheiro(l.comissao_centavos + l.tarifa_banco_centavos + l.tarifa_emissao_centavos),
        apoio: `comissão ${dinheiro(l.comissao_centavos)} + tarifas ${dinheiro(l.tarifa_banco_centavos + l.tarifa_emissao_centavos)}`, menor: true, ic: 'relatorio' }),
      kpi({ rotulo: 'Transferido para você', valor: dinheiro(l.repassado_centavos), menor: true, ic: 'troca' })),

    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('Recebimentos por dia', barrasPorDia({ dados: d.serie.map((s) => ({ data: s.data, valor: s.bruto_centavos, titulos: s.titulos })) })),
      cartao('Divisão do que foi recebido', l.bruto_centavos ? barraSplit({
        total: l.bruto_centavos,
        partes: [
          { rotulo: 'Líquido para você', valor: l.liquido_centavos },
          { rotulo: 'Tarifa bancária', valor: l.tarifa_banco_centavos + l.tarifa_emissao_centavos },
          { rotulo: 'Comissão PayAx', valor: l.comissao_centavos },
        ],
      }) : el('p', { class: 'vazio' }, 'Nada recebido no período.'))),

    el('div', { style: 'margin-top:14px' }, cartao('Situação dos boletos emitidos no período', tabela({
      colunas: [
        { titulo: 'Situação', campo: 'situacao' },
        { titulo: 'Títulos', dir: true, campo: 'titulos' },
        { titulo: 'Valor', dir: true, conteudo: (x) => dinheiro(x.valor) },
      ],
      itens: [
        { situacao: 'Pagos', titulos: numero(b.liquidados), valor: b.valor_liquidado_centavos },
        { situacao: 'A vencer', titulos: numero(b.a_vencer), valor: null },
        { situacao: 'Vencidos em aberto', titulos: numero(b.vencidos), valor: b.valor_vencido_centavos },
        { situacao: 'Baixados', titulos: numero(b.baixados), valor: null },
      ],
    }))),

    el('div', { style: 'margin-top:14px' }, cartao('A sua tabela de preços', el('div', { class: 'pares' },
      el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Comissão sobre o valor pago'), el('span', { class: 'val' }, d.preco.percentual_texto)),
      el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Comissão mínima'), el('span', { class: 'val' }, dinheiro(d.preco.comissao_minima_centavos))),
      el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Comissão máxima'), el('span', { class: 'val' }, d.preco.comissao_maxima_centavos === null ? 'sem teto' : dinheiro(d.preco.comissao_maxima_centavos))),
      el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Tarifa por título pago'), el('span', { class: 'val' }, dinheiro(d.preco.tarifa_liquidacao_centavos))),
      el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Tarifa por boleto emitido'), el('span', { class: 'val' }, dinheiro(d.preco.tarifa_emissao_centavos))),
      el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Tarifa por transferência'), el('span', { class: 'val' }, dinheiro(d.preco.tarifa_repasse_centavos)))))),
  );
}
