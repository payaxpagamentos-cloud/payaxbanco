import { api } from '../api.js';
import { el, $, limpar, dinheiro, emReais, dataBr, icone, indicador, tabela, modal, toast, acao, etiqueta, lerForm, opcoes, confirmar, colunas, percentual, hojeLocal, somarDias, competenciaAtual, mesPorExtenso } from '../ui.js';

/** Contas a pagar e a receber, fluxo de caixa e DRE do mês. */
export default async function financeiro({ alvo, definirTitulo }) {
  let aba = 'pagar';
  let competencia = competenciaAtual();
  const [categorias, fornecedores] = await Promise.all([api.get('/financeiro/categorias'), api.get('/produtos/fornecedores')]);

  async function desenhar() {
    const resumo = await api.get('/financeiro/resumo');
    definirTitulo('Financeiro', 'Contas, fluxo de caixa e resultado');
    limpar(alvo,
      el('div', { class: 'grade' },
        indicador({ rotulo: 'A pagar vencido', valor: dinheiro(resumo.pagar.vencido_centavos), tom: resumo.pagar.vencido_centavos ? 'vermelho' : null, nota: `hoje ${dinheiro(resumo.pagar.hoje_centavos)}` }),
        indicador({ rotulo: 'A pagar (7 dias)', valor: dinheiro(resumo.pagar.semana_centavos), nota: `total em aberto ${dinheiro(resumo.pagar.aberto_centavos)}` }),
        indicador({ rotulo: 'A receber em aberto', valor: dinheiro(resumo.receber.aberto_centavos), tom: 'verde', nota: `vencido ${dinheiro(resumo.receber.vencido_centavos)}` }),
        indicador({ rotulo: 'Saldo previsto', valor: dinheiro(resumo.saldo_previsto_centavos), tom: resumo.saldo_previsto_centavos >= 0 ? 'verde' : 'vermelho', nota: 'a receber menos a pagar' })),
      el('div', { class: 'linha entre' },
        el('div', { class: 'abas' }, [['pagar', 'Contas a pagar'], ['receber', 'Contas a receber'], ['fluxo', 'Fluxo de caixa'], ['dre', 'DRE do mês']].map(([chave, rotulo]) =>
          el('button', { class: aba === chave ? 'ativa' : '', onclick: () => { aba = chave; desenhar(); } }, rotulo))),
        ['pagar', 'receber'].includes(aba) ? el('button', { class: 'btn primario', onclick: () => editar(null, aba) }, icone('mais'), aba === 'pagar' ? 'Nova conta a pagar' : 'Nova conta a receber') : null),
      el('div', { id: 'corpo' }));
    recarregar();
  }

  async function recarregar() {
    const corpo = $('#corpo');
    if (aba === 'fluxo') return fluxo(corpo);
    if (aba === 'dre') return dre(corpo);

    const status = $('#filtro-status')?.value ?? 'aberto';
    const lista = await api.get(`/financeiro/lancamentos?tipo=${aba}${status ? `&status=${status}` : ''}`);
    const total = lista.reduce((s, l) => s + l.valor_centavos, 0);
    limpar(corpo, el('section', { class: 'cartao' },
      el('div', { class: 'linha entre', style: 'margin-bottom: 12px' },
        el('select', { id: 'filtro-status', style: 'width: auto', onchange: recarregar },
          opcoes([{ id: 'aberto', nome: 'Em aberto' }, { id: 'pago', nome: 'Baixados' }, { id: 'cancelado', nome: 'Cancelados' }, { id: '', nome: 'Todos' }], { selecionado: status })),
        el('strong', {}, `${lista.length} lançamento(s) · ${dinheiro(total)}`)),
      tabela([
        { titulo: 'Vencimento', celula: (l) => el('span', { class: l.status === 'aberto' && l.vencimento < hojeLocal() ? 'negativo' : '' }, dataBr(l.vencimento)) },
        { titulo: 'Descrição', celula: (l) => el('span', {}, el('div', {}, l.descricao), el('div', { class: 'pequeno mudo' }, l.fornecedor ?? l.morador ?? l.categoria)) },
        { titulo: 'Categoria', celula: (l) => etiqueta(l.categoria) },
        { titulo: 'Valor', direita: true, celula: (l) => el('strong', {}, dinheiro(l.valor_centavos)) },
        { titulo: 'Situação', direita: true, celula: (l) => etiqueta(l.status, l.status === 'pago' ? 'ok' : l.status === 'cancelado' ? 'erro' : 'aviso') },
      ], lista, { aoClicar: ficha, vazio: 'Nenhuma conta com esse filtro.' })));
  }

  async function ficha(l) {
    await modal(l.descricao, (fechar) => [
      el('div', { class: 'grade' },
        indicador({ rotulo: 'Valor', valor: dinheiro(l.valor_centavos) }),
        indicador({ rotulo: 'Vencimento', valor: dataBr(l.vencimento) }),
        indicador({ rotulo: 'Situação', valor: l.status, nota: l.pago_em ? `baixado em ${dataBr(l.pago_em)} (${l.forma ?? '—'})` : '' })),
      el('p', { class: 'mudo pequeno' }, [l.categoria, l.fornecedor, l.morador, l.observacao].filter(Boolean).join(' · ')),
      el('div', { class: 'linha fim' },
        el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Fechar'),
        l.status === 'aberto' ? el('button', { class: 'btn', onclick: () => { fechar(); editar(l, l.tipo); } }, icone('editar'), 'Editar') : null,
        l.status === 'aberto' ? el('button', { class: 'btn perigo fantasma', onclick: async () => {
          if (!await confirmar('Cancelar o lançamento?', 'Ele deixa de contar no financeiro.', 'Cancelar', true)) return;
          await api.post(`/financeiro/lancamentos/${l.id}/cancelar`, { motivo: 'Cancelado pela gestão' });
          fechar(); recarregar();
        } }, 'Cancelar') : null,
        l.status === 'pago' ? el('button', { class: 'btn', onclick: async (e) => {
          await acao(e.target, async () => { await api.post(`/financeiro/lancamentos/${l.id}/estornar`, {}); toast('Baixa estornada.'); fechar(); recarregar(); });
        } }, 'Estornar baixa') : null,
        l.status === 'aberto' ? el('button', { class: 'btn primario', onclick: () => { fechar(); baixar(l); } }, icone('check'), l.tipo === 'pagar' ? 'Pagar' : 'Receber') : null),
    ]);
  }

  const baixar = (l) => modal(l.tipo === 'pagar' ? 'Pagar a conta' : 'Registrar o recebimento', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.post(`/financeiro/lancamentos/${l.id}/baixar`, lerForm(e.target));
        toast('Lançamento baixado.');
        fechar();
        recarregar();
      });
    },
  },
  el('p', { class: 'mudo' }, `${l.descricao} · ${dinheiro(l.valor_centavos)}`),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Data', el('input', { name: 'pago_em', type: 'date', value: hojeLocal() })),
    el('label', { class: 'campo' }, 'Valor (R$)', el('input', { name: 'valor', inputmode: 'decimal', value: emReais(l.valor_centavos) }))),
  el('label', { class: 'campo' }, 'Forma', el('select', { name: 'forma' }, opcoes([
    { id: 'dinheiro', nome: 'Dinheiro' }, { id: 'pix', nome: 'PIX' }, { id: 'transferencia', nome: 'Transferência' },
    { id: 'boleto', nome: 'Boleto' }, { id: 'debito', nome: 'Cartão de débito' }, { id: 'credito', nome: 'Cartão de crédito' }]))),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Confirmar'))));

  const editar = (l, tipo) => modal(l ? 'Editar lançamento' : tipo === 'pagar' ? 'Nova conta a pagar' : 'Nova conta a receber', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        if (l) await api.patch(`/financeiro/lancamentos/${l.id}`, d);
        else await api.post('/financeiro/lancamentos', { ...d, tipo });
        toast('Lançamento salvo.');
        fechar();
        recarregar();
      });
    },
  },
  el('label', { class: 'campo' }, 'Descrição', el('input', { name: 'descricao', required: true, value: l?.descricao ?? '', autofocus: true, placeholder: 'Ex.: Energia elétrica de novembro' })),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Valor (R$)', el('input', { name: 'valor', inputmode: 'decimal', required: true, value: l ? emReais(l.valor_centavos) : '' })),
    el('label', { class: 'campo' }, 'Vencimento', el('input', { name: 'vencimento', type: 'date', required: true, value: l?.vencimento ?? hojeLocal() }))),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Categoria', el('select', { name: 'categoria' }, opcoes(categorias.map((c) => ({ id: c, nome: c })), { selecionado: l?.categoria ?? 'Outros' }))),
    tipo === 'pagar' ? el('label', { class: 'campo' }, 'Fornecedor', el('select', { name: 'fornecedor_id' }, opcoes(fornecedores, { selecionado: l?.fornecedor_id, vazio: 'Sem fornecedor' }))) : null),
  el('label', { class: 'campo' }, 'Observação', el('input', { name: 'observacao', value: l?.observacao ?? '' })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Salvar'))));

  /* ---------- fluxo de caixa ---------- */
  async function fluxo(corpo) {
    const de = somarDias(hojeLocal(), -29);
    const f = await api.get(`/financeiro/fluxo?de=${de}&ate=${hojeLocal()}`);
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ rotulo: 'Entradas (30 dias)', valor: dinheiro(f.entradas_centavos), tom: 'verde' }),
        indicador({ rotulo: 'Saídas (30 dias)', valor: dinheiro(f.saidas_centavos), tom: 'vermelho' }),
        indicador({ rotulo: 'Resultado do período', valor: dinheiro(f.saldo_centavos), tom: f.saldo_centavos >= 0 ? 'verde' : 'vermelho' })),
      el('section', { class: 'cartao' },
        el('h2', {}, 'Entradas por dia'),
        f.dias.length ? colunas(f.dias.map((d) => ({ rotulo: d.dia.slice(8, 10), valor: d.entradas_centavos }))) : el('div', { class: 'vazio' }, 'Sem movimento no período.'),
        tabela([
          { titulo: 'Dia', celula: (d) => dataBr(d.dia) },
          { titulo: 'Vendas à vista', direita: true, celula: (d) => dinheiro(d.vendas) },
          { titulo: 'Recebimentos', direita: true, celula: (d) => dinheiro(d.recebimentos) },
          { titulo: 'Pagamentos', direita: true, celula: (d) => el('span', { class: 'negativo' }, dinheiro(d.saidas_centavos)) },
          { titulo: 'Saldo do dia', direita: true, celula: (d) => el('span', { class: d.saldo_centavos >= 0 ? 'positivo' : 'negativo' }, dinheiro(d.saldo_centavos)) },
          { titulo: 'Acumulado', direita: true, celula: (d) => el('strong', {}, dinheiro(d.acumulado_centavos)) },
        ], f.dias, { vazio: 'Sem movimento no período.' })));
  }

  /* ---------- DRE ---------- */
  async function dre(corpo) {
    const d = await api.get(`/financeiro/dre?competencia=${competencia}`);
    const linha = (rotulo, valor, { forte = false, tom = '' } = {}) => el('div', { class: 'linha entre', style: forte ? 'padding-top: 8px; border-top: 1px solid var(--vidro-borda)' : '' },
      el('span', { class: forte ? 'destaque' : 'mudo' }, rotulo), el('strong', { class: `num ${tom}` }, dinheiro(valor)));
    limpar(corpo,
      el('section', { class: 'cartao' },
        el('div', { class: 'linha entre' },
          el('h2', {}, `Resultado de ${mesPorExtenso(competencia)}`),
          el('input', { type: 'month', style: 'width: auto', value: competencia, onchange: (e) => { competencia = e.target.value; recarregar(); } })),
        el('div', { class: 'coluna', style: 'max-width: 620px' },
          linha('Receita bruta das vendas', d.receita_bruta_centavos),
          linha('(-) Descontos concedidos', -d.descontos_centavos),
          linha('= Receita líquida', d.receita_liquida_centavos, { forte: true }),
          linha('(-) Custo da mercadoria vendida', -d.cmv_centavos),
          linha('= Lucro bruto', d.lucro_bruto_centavos, { forte: true, tom: 'positivo' }),
          linha(`Margem bruta (${percentual(d.margem_bruta_bp)})`, d.lucro_bruto_centavos),
          linha('(-) Taxas da maquininha', -d.taxas_cartao_centavos),
          linha('(-) Perdas e quebras', -d.perdas_centavos),
          linha('(-) Despesas pagas no mês', -d.despesas_centavos),
          linha('= Resultado do mês', d.resultado_centavos, { forte: true, tom: d.resultado_centavos >= 0 ? 'positivo' : 'negativo' }))),
      el('section', { class: 'cartao' },
        el('h2', {}, 'Despesas por categoria'),
        tabela([
          { titulo: 'Categoria', celula: (x) => x.categoria },
          { titulo: 'Valor pago', direita: true, celula: (x) => dinheiro(x.total) },
        ], d.despesas, { vazio: 'Nenhuma despesa paga neste mês.' }),
        el('p', { class: 'pequeno mudo' }, 'As compras de mercadoria não entram como despesa: elas viram estoque e pesam no resultado como custo da mercadoria vendida.')));
  }

  await desenhar();
}
