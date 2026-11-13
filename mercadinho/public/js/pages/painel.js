import { api } from '../api.js';
import { el, limpar, dinheiro, qtd, dataHora, icone, indicador, tabela, colunas, etiqueta, repetir, percentual, dataBr } from '../ui.js';

/** Tela inicial: o dia de hoje, o caixa, os alertas do estoque e o resumo do financeiro. */
export default async function painel({ alvo, definirTitulo }) {
  const desenhar = async () => {
    const d = await api.get('/painel');
    definirTitulo('Painel', `Hoje, ${dataBr(d.dia)}`);
    const serie = d.ultimos_7_dias.por_dia.map((x) => ({ rotulo: x.dia.slice(8, 10) + '/' + x.dia.slice(5, 7), valor: x.total }));

    limpar(alvo,
      el('div', { class: 'grade' },
        indicador({ simbolo: 'pdv', rotulo: 'Vendas de hoje', valor: dinheiro(d.vendas_hoje.total_centavos), nota: `${d.vendas_hoje.vendas} venda(s) · ticket ${dinheiro(d.vendas_hoje.ticket_medio_centavos)}` }),
        indicador({ simbolo: 'financeiro', rotulo: 'Lucro de hoje', valor: dinheiro(d.vendas_hoje.lucro_centavos), tom: 'verde', nota: 'Venda menos o custo da mercadoria' }),
        indicador({ simbolo: 'produtos', cor: 'azul', rotulo: 'Estoque na prateleira', valor: dinheiro(d.estoque.valor.custo_centavos), nota: `${d.estoque.valor.produtos} produtos · ${dinheiro(d.estoque.valor.venda_centavos)} a preço de venda` }),
        indicador({
          simbolo: 'moradores', cor: d.moradores_devedores.total > 0 ? 'vermelho' : 'roxo',
          rotulo: 'Fiado em aberto', valor: dinheiro(d.moradores_devedores.total),
          tom: d.moradores_devedores.total > 0 ? 'vermelho' : null, nota: `${d.moradores_devedores.moradores} morador(es) com saldo`,
        })),

      el('div', { class: 'grade', style: 'grid-template-columns: repeat(auto-fit, minmax(330px, 1fr))' },
        el('section', { class: 'cartao' },
          el('div', { class: 'linha entre' }, el('h2', {}, 'Últimos 7 dias'), etiqueta(dinheiro(d.ultimos_7_dias.total_centavos), 'ok')),
          serie.length ? colunas(serie) : el('div', { class: 'vazio' }, 'Sem vendas na semana.'),
          el('div', { class: 'linha entre pequeno mudo', style: 'margin-top:12px' },
            el('span', {}, `Ticket médio ${dinheiro(d.ultimos_7_dias.ticket_medio_centavos)}`),
            el('span', {}, `Margem ${percentual(d.ultimos_7_dias.margem_bp)}`))),

        el('section', { class: 'cartao' },
          el('div', { class: 'linha entre' }, el('h2', {}, 'Terminal do balcão'),
            d.pix_a_conferir.n ? etiqueta(`${d.pix_a_conferir.n} PIX a conferir`, 'aviso') : null),
          d.terminais.length
            ? el('div', { class: 'coluna' },
              ...d.terminais.map((t) => el('div', { class: 'linha entre' },
                el('span', {}, el('div', { class: 'destaque' }, t.nome),
                  el('div', { class: 'pequeno mudo' }, t.pareado_em ? `último uso ${dataHora(t.ultimo_uso)}` : 'aguardando pareamento')),
                el('span', { class: 'linha' },
                  el('strong', { class: 'num' }, dinheiro(t.vendas_hoje.total)),
                  etiqueta(t.ativo ? 'ativo' : 'desativado', t.ativo ? 'ok' : 'erro')))),
              el('a', { class: 'btn primario', href: '#/vendas' }, icone('pdv'), 'Ver as compras do terminal'))
            : el('div', { class: 'coluna' },
              el('p', { class: 'mudo' }, 'Nenhum terminal cadastrado. O cliente registra a compra e paga sozinho na tela do balcão.'),
              el('a', { class: 'btn primario', href: '#/config' }, icone('config'), 'Cadastrar o terminal')))),

      el('div', { class: 'grade', style: 'grid-template-columns: repeat(auto-fit, minmax(330px, 1fr))' },
        el('section', { class: 'cartao' },
          el('div', { class: 'linha entre' }, el('h2', {}, 'Precisa repor'), d.estoque.baixo ? etiqueta(`${d.estoque.baixo} item(ns)`, 'aviso') : etiqueta('tudo certo', 'ok')),
          tabela([
            { titulo: 'Produto', celula: (p) => p.nome },
            { titulo: 'Saldo', direita: true, celula: (p) => qtd(p.estoque_mil, p.unidade) },
            { titulo: 'Mínimo', direita: true, celula: (p) => qtd(p.estoque_minimo_mil) },
          ], d.estoque.lista_baixo, { vazio: 'Nenhum produto abaixo do mínimo.' }),
          el('a', { class: 'btn pequeno', href: '#/compras', style: 'margin-top:14px' }, icone('compras'), 'Ver sugestão de compra')),

        el('section', { class: 'cartao' },
          el('div', { class: 'linha entre' }, el('h2', {}, 'Validade'), d.estoque.vencidos ? etiqueta(`${d.estoque.vencidos} vencido(s)`, 'erro') : etiqueta(`${d.estoque.vencendo} vencendo`, d.estoque.vencendo ? 'aviso' : 'ok')),
          tabela([
            { titulo: 'Produto', celula: (l) => l.produto },
            { titulo: 'Validade', celula: (l) => el('span', { class: l.validade < d.dia ? 'negativo' : '' }, dataBr(l.validade)) },
            { titulo: 'Qtd.', direita: true, celula: (l) => qtd(l.qtd_mil, l.unidade) },
          ], d.estoque.lista_vencendo, { vazio: 'Nenhum lote perto do vencimento.' }))),

      el('div', { class: 'grade', style: 'grid-template-columns: repeat(auto-fit, minmax(330px, 1fr))' },
        el('section', { class: 'cartao' },
          el('h2', {}, 'Financeiro'),
          el('div', { class: 'coluna' },
            linhaFinanceira('A pagar vencido', d.financeiro.pagar.vencido_centavos, 'negativo'),
            linhaFinanceira('A pagar nos próximos 7 dias', d.financeiro.pagar.semana_centavos),
            linhaFinanceira('A receber em aberto', d.financeiro.receber.aberto_centavos, 'positivo'),
            linhaFinanceira('Saldo previsto', d.financeiro.saldo_previsto_centavos, d.financeiro.saldo_previsto_centavos >= 0 ? 'positivo' : 'negativo'),
            el('a', { class: 'btn pequeno', href: '#/financeiro' }, icone('financeiro'), 'Abrir o financeiro'))),

        el('section', { class: 'cartao' },
          el('h2', {}, 'Campeões do mês'),
          tabela([
            { titulo: 'Produto', celula: (p) => p.nome },
            { titulo: 'Saiu', direita: true, celula: (p) => qtd(p.qtd_mil, p.unidade) },
            { titulo: 'Faturou', direita: true, celula: (p) => dinheiro(p.total_centavos) },
          ], d.mais_vendidos, { vazio: 'Ainda não há vendas no período.' }))),

      el('section', { class: 'cartao' },
        el('h2', {}, 'Últimas vendas'),
        tabela([
          { titulo: 'Venda', celula: (v) => `#${v.id}` },
          { titulo: 'Hora', celula: (v) => dataHora(v.fechada_em) },
          { titulo: 'Terminal', celula: (v) => v.terminal ?? '—' },
          { titulo: 'Morador', celula: (v) => v.morador ?? '—' },
          { titulo: 'Total', direita: true, celula: (v) => dinheiro(v.total_centavos) },
        ], d.ultimas_vendas, { vazio: 'Nenhuma venda registrada ainda.' })));
  };

  const linhaFinanceira = (rotulo, valor, tom) => el('div', { class: 'linha entre' },
    el('span', { class: 'mudo' }, rotulo), el('strong', { class: `num ${tom ?? ''}` }, dinheiro(valor)));

  await desenhar();
  return repetir(desenhar, 60_000);
}
