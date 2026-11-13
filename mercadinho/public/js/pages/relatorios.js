import { api, baixar } from '../api.js';
import { el, $, limpar, dinheiro, qtd, percentual, dataBr, dataHora, icone, indicador, tabela, etiqueta, colunas, rosca, toast, acao, hojeLocal, somarDias, opcoes, FORMAS } from '../ui.js';

const CORES = ['#22D3A5', '#5B9DFF', '#B57BFF', '#FFC65C', '#FF7A8A', '#5BE8D4', '#9AA0AA'];

/** Relatórios de venda, giro, consumo por morador e perdas — com exportação em CSV. */
export default async function relatorios({ alvo, definirTitulo }) {
  let aba = 'vendas';
  let periodo = { de: somarDias(hojeLocal(), -29), ate: hojeLocal() };
  const ABAS = [['vendas', 'Vendas'], ['mais-vendidos', 'Mais vendidos'], ['mais-lucrativos', 'Mais lucrativos'], ['abc', 'Curva ABC'], ['categorias', 'Categorias'], ['moradores', 'Moradores'], ['sem-giro', 'Sem giro'], ['perdas', 'Perdas']];

  function desenhar() {
    definirTitulo('Relatórios', `${dataBr(periodo.de)} a ${dataBr(periodo.ate)}`);
    limpar(alvo,
      el('section', { class: 'cartao' },
        el('div', { class: 'linha entre' },
          el('div', { class: 'linha' },
            el('label', { class: 'campo' }, 'De', el('input', { type: 'date', value: periodo.de, onchange: (e) => { periodo.de = e.target.value; recarregar(); } })),
            el('label', { class: 'campo' }, 'Até', el('input', { type: 'date', value: periodo.ate, onchange: (e) => { periodo.ate = e.target.value; recarregar(); } })),
            el('select', { style: 'width: auto; align-self: end', onchange: (e) => {
              const dias = Number(e.target.value);
              periodo = { de: somarDias(hojeLocal(), -dias + 1), ate: hojeLocal() };
              desenhar();
            } }, opcoes([{ id: 7, nome: 'Últimos 7 dias' }, { id: 30, nome: 'Últimos 30 dias' }, { id: 90, nome: 'Últimos 90 dias' }], { selecionado: 30, vazio: 'Atalhos' }))),
          el('button', { class: 'btn', onclick: (e) => acao(e.target, () => baixar(`/relatorios/csv/${aba === 'categorias' ? 'mais-vendidos' : aba}?de=${periodo.de}&ate=${periodo.ate}`, `${aba}-${periodo.de}.csv`)) }, icone('baixar'), 'Exportar CSV'))),
      el('div', { class: 'abas' }, ABAS.map(([chave, rotulo]) =>
        el('button', { class: aba === chave ? 'ativa' : '', onclick: () => { aba = chave; recarregar(); } }, rotulo))),
      el('div', { id: 'corpo' }));
    recarregar();
  }

  async function recarregar() {
    const corpo = $('#corpo');
    limpar(corpo, el('div', { class: 'carregando' }, el('div', { class: 'girando' })));
    const q = `?de=${periodo.de}&ate=${periodo.ate}`;
    definirTitulo('Relatórios', `${dataBr(periodo.de)} a ${dataBr(periodo.ate)}`);
    for (const botao of [...document.querySelectorAll('.abas button')]) {
      botao.classList.toggle('ativa', botao.textContent === ABAS.find(([c]) => c === aba)?.[1]);
    }

    if (aba === 'vendas') {
      const v = await api.get(`/relatorios/vendas${q}`);
      return limpar(corpo,
        el('div', { class: 'grade' },
          indicador({ simbolo: 'pdv', rotulo: 'Faturamento', valor: dinheiro(v.total_centavos), nota: `${v.vendas} venda(s)` }),
          indicador({ simbolo: 'financeiro', rotulo: 'Lucro bruto', valor: dinheiro(v.lucro_centavos), tom: 'verde', nota: `margem ${percentual(v.margem_bp)}` }),
          indicador({ simbolo: 'caixa', cor: 'azul', rotulo: 'Ticket médio', valor: dinheiro(v.ticket_medio_centavos) }),
          indicador({ simbolo: 'editar', cor: 'ambar', rotulo: 'Descontos', valor: dinheiro(v.descontos_centavos) })),
        el('section', { class: 'cartao' },
          el('h2', {}, 'Faturamento por dia'),
          v.por_dia.length ? colunas(v.por_dia.map((d) => ({ rotulo: d.dia.slice(8, 10), valor: d.total }))) : el('div', { class: 'vazio' }, 'Sem vendas no período.')),
        el('div', { class: 'grade', style: 'grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))' },
          el('section', { class: 'cartao' },
            el('h2', {}, 'Como os clientes pagaram'),
            v.por_forma.length
              ? rosca(v.por_forma.map((f, i) => ({ rotulo: FORMAS[f.forma] ?? f.forma, valor: f.total, cor: CORES[i % CORES.length] })), { centro: dinheiro(v.total_centavos) })
              : el('div', { class: 'vazio' }, 'Sem pagamentos no período.')),
          el('section', { class: 'cartao' },
            el('h2', {}, 'Movimento por hora'),
            v.por_hora.length ? colunas(v.por_hora.map((h) => ({ rotulo: `${String(h.hora).padStart(2, '0')}h`, valor: h.total }))) : el('div', { class: 'vazio' }, 'Sem vendas no período.'))));
    }

    if (aba === 'mais-lucrativos') {
      const lista = await api.get(`/relatorios/mais-lucrativos${q}`);
      const lucro = lista.reduce((s, p) => s + p.lucro_centavos, 0);
      return limpar(corpo, el('section', { class: 'cartao' },
        el('p', { class: 'mudo pequeno', style: 'margin-top: 0' }, 'Os produtos que mais deixam dinheiro no caixa depois de pagar a mercadoria — não os que mais faturam. Quem fatura muito com margem baixa fica mais para baixo aqui.'),
        tabela([
          { titulo: '#', celula: (p) => el('span', { class: 'mudo' }, String(lista.indexOf(p) + 1)) },
          { titulo: 'Produto', celula: (p) => el('span', {}, el('div', { class: 'destaque' }, p.nome), el('div', { class: 'pequeno mudo' }, p.categoria ?? 'sem categoria')) },
          { titulo: 'Quantidade', direita: true, celula: (p) => qtd(p.qtd_mil, p.unidade) },
          { titulo: 'Faturamento', direita: true, celula: (p) => dinheiro(p.total_centavos) },
          { titulo: 'Lucro', direita: true, celula: (p) => el('strong', { class: 'positivo' }, dinheiro(p.lucro_centavos)) },
          { titulo: 'Margem', direita: true, celula: (p) => percentual(p.margem_bp) },
          { titulo: 'Do lucro total', direita: true, celula: (p) => percentual(lucro ? Math.round((p.lucro_centavos / lucro) * 10_000) : 0) },
        ], lista, { vazio: 'Sem vendas no período.' })));
    }

    if (aba === 'mais-vendidos' || aba === 'abc') {
      const lista = await api.get(`/relatorios/${aba}${q}`);
      return limpar(corpo, el('section', { class: 'cartao' }, tabela([
        ...(aba === 'abc' ? [{ titulo: 'Classe', celula: (p) => etiqueta(p.classe, p.classe === 'A' ? 'ok' : p.classe === 'B' ? 'info' : null) }] : []),
        { titulo: 'Produto', celula: (p) => el('span', {}, el('div', { class: 'destaque' }, p.nome), el('div', { class: 'pequeno mudo' }, p.categoria ?? 'sem categoria')) },
        { titulo: 'Quantidade', direita: true, celula: (p) => qtd(p.qtd_mil, p.unidade) },
        { titulo: 'Faturamento', direita: true, celula: (p) => el('strong', {}, dinheiro(p.total_centavos)) },
        { titulo: 'Lucro', direita: true, celula: (p) => el('span', { class: 'positivo' }, dinheiro(p.lucro_centavos)) },
        { titulo: aba === 'abc' ? 'Acumulado' : 'Participação', direita: true, celula: (p) => percentual(aba === 'abc' ? p.acumulado_bp : p.participacao_bp) },
      ], lista, { vazio: 'Sem vendas no período.' })));
    }

    if (aba === 'categorias') {
      const lista = await api.get(`/relatorios/categorias${q}`);
      return limpar(corpo,
        el('section', { class: 'cartao' },
          el('h2', {}, 'Participação por categoria'),
          lista.length ? rosca(lista.map((c) => ({ rotulo: c.categoria, valor: c.total_centavos, cor: c.cor })), { centro: dinheiro(lista.reduce((s, c) => s + c.total_centavos, 0)) })
            : el('div', { class: 'vazio' }, 'Sem vendas no período.')),
        el('section', { class: 'cartao' }, tabela([
          { titulo: 'Categoria', celula: (c) => el('span', { class: 'linha' }, el('span', { class: 'ponto', style: `color: ${c.cor}` }), c.categoria) },
          { titulo: 'Faturamento', direita: true, celula: (c) => dinheiro(c.total_centavos) },
          { titulo: 'Custo', direita: true, celula: (c) => dinheiro(c.custo_centavos) },
          { titulo: 'Lucro', direita: true, celula: (c) => el('span', { class: 'positivo' }, dinheiro(c.lucro_centavos)) },
        ], lista)));
    }

    if (aba === 'moradores') {
      const lista = await api.get(`/relatorios/moradores${q}`);
      return limpar(corpo, el('section', { class: 'cartao' }, tabela([
        { titulo: 'Morador', celula: (m) => el('span', {}, el('div', { class: 'destaque' }, m.nome), el('div', { class: 'pequeno mudo' }, `${m.bloco}/${m.unidade}`)) },
        { titulo: 'Compras', direita: true, celula: (m) => m.compras },
        { titulo: 'Total', direita: true, celula: (m) => el('strong', {}, dinheiro(m.total_centavos)) },
        { titulo: 'Saldo em aberto', direita: true, celula: (m) => el('span', { class: m.saldo_centavos > 0 ? 'negativo' : '' }, dinheiro(m.saldo_centavos)) },
      ], lista, { vazio: 'Nenhuma compra identificada por morador no período.' })));
    }

    if (aba === 'sem-giro') {
      const lista = await api.get(`/relatorios/sem-giro${q}`);
      return limpar(corpo, el('section', { class: 'cartao' },
        el('p', { class: 'mudo' }, 'Produtos com saldo que não venderam nada no período — dinheiro parado na prateleira.'),
        tabela([
          { titulo: 'Produto', celula: (p) => p.nome },
          { titulo: 'Estoque', direita: true, celula: (p) => qtd(p.estoque_mil, p.unidade) },
          { titulo: 'Preço', direita: true, celula: (p) => dinheiro(p.preco_centavos) },
          { titulo: 'Valor parado', direita: true, celula: (p) => el('strong', {}, dinheiro(p.parado_centavos)) },
        ], lista, { vazio: 'Tudo girou no período.' })));
    }

    const lista = await api.get(`/relatorios/perdas${q}`);
    limpar(corpo, el('section', { class: 'cartao' },
      el('div', { class: 'linha entre' }, el('h2', {}, 'Perdas e quebras'), etiqueta(dinheiro(lista.reduce((s, p) => s + p.valor_centavos, 0)), 'erro')),
      tabela([
        { titulo: 'Quando', celula: (p) => dataHora(p.criado_em) },
        { titulo: 'Produto', celula: (p) => p.produto },
        { titulo: 'Quantidade', direita: true, celula: (p) => qtd(p.qtd_mil, p.unidade) },
        { titulo: 'Valor', direita: true, celula: (p) => dinheiro(p.valor_centavos) },
        { titulo: 'Motivo', celula: (p) => p.observacao ?? '—' },
        { titulo: 'Quem', celula: (p) => p.usuario ?? '—' },
      ], lista, { vazio: 'Nenhuma perda registrada. Ótimo sinal.' })));
  }

  desenhar();
}
