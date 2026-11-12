import { api } from '../api.js';
import { el, $, limpar, dinheiro, qtd, dataBr, dataHora, icone, indicador, tabela, modal, toast, acao, etiqueta, lerForm, opcoes, confirmar, hojeLocal, somarDias } from '../ui.js';

/** Movimentos de estoque, alertas de reposição e validade, perdas e inventário. */
export default async function estoque({ alvo, usuario, definirTitulo }) {
  const podeMexer = ['admin', 'gerente', 'estoque'].includes(usuario.perfil);
  let aba = 'alertas';

  async function desenhar() {
    definirTitulo('Estoque', 'Saldos, perdas, validade e contagem');
    limpar(alvo,
      el('div', { class: 'linha entre' },
        el('div', { class: 'abas' }, [['alertas', 'Alertas'], ['movimentos', 'Movimentos'], ['inventarios', 'Inventários']].map(([chave, rotulo]) =>
          el('button', { class: aba === chave ? 'ativa' : '', onclick: () => { aba = chave; desenhar(); } }, rotulo))),
        podeMexer ? el('div', { class: 'linha' },
          el('button', { class: 'btn', onclick: () => lancamento('entrada') }, icone('mais'), 'Entrada'),
          el('button', { class: 'btn', onclick: () => lancamento('perda') }, icone('alerta'), 'Perda'),
          el('button', { class: 'btn', onclick: () => lancamento('ajuste') }, icone('editar'), 'Acerto'),
          aba === 'inventarios' ? el('button', { class: 'btn primario', onclick: novoInventario }, icone('estoque'), 'Novo inventário') : null) : null),
      el('div', { id: 'corpo' }));
    recarregar();
  }

  async function recarregar() {
    const corpo = $('#corpo');
    if (aba === 'alertas') {
      const [a, valor] = await Promise.all([api.get('/estoque/alertas'), api.get('/estoque/valor')]);
      return limpar(corpo, el('div', { class: 'coluna' },
        el('div', { class: 'grade' },
          indicador({ rotulo: 'Valor em estoque (custo)', valor: dinheiro(valor.custo_centavos), nota: `${valor.produtos} produtos com saldo` }),
          indicador({ rotulo: 'A preço de venda', valor: dinheiro(valor.venda_centavos), nota: `lucro potencial ${dinheiro(valor.venda_centavos - valor.custo_centavos)}`, tom: 'verde' }),
          indicador({ rotulo: 'Abaixo do mínimo', valor: String(a.estoque_baixo.length), tom: a.estoque_baixo.length ? 'vermelho' : null, nota: `${a.sem_estoque} sem nenhum saldo` }),
          indicador({ rotulo: 'Lotes vencidos', valor: String(a.vencidos.length), tom: a.vencidos.length ? 'vermelho' : null, nota: `${a.vencendo.length} vencem em ${a.alerta_validade_dias} dias` })),
        el('section', { class: 'cartao' },
          el('h2', {}, 'Precisa repor'),
          tabela([
            { titulo: 'Produto', celula: (p) => p.nome },
            { titulo: 'Saldo', direita: true, celula: (p) => el('span', { class: p.estoque_mil <= 0 ? 'negativo' : '' }, qtd(p.estoque_mil, p.unidade)) },
            { titulo: 'Mínimo', direita: true, celula: (p) => qtd(p.estoque_minimo_mil) },
            { titulo: 'Cobertura', direita: true, celula: (p) => el('div', { class: `barra ${p.estoque_mil <= p.estoque_minimo_mil ? 'alerta' : ''}`, style: 'width: 90px' },
              el('span', { style: `width: ${Math.min(100, Math.max(0, (p.estoque_mil / Math.max(1, p.estoque_minimo_mil)) * 100))}%` })) },
          ], a.estoque_baixo, { vazio: 'Todo o estoque está acima do mínimo.' })),
        el('section', { class: 'cartao' },
          el('h2', {}, 'Validade'),
          tabela([
            { titulo: 'Produto', celula: (l) => l.produto },
            { titulo: 'Validade', celula: (l) => el('span', { class: l.validade < hojeLocal() ? 'negativo' : '' }, dataBr(l.validade)) },
            { titulo: 'Quantidade', direita: true, celula: (l) => qtd(l.qtd_mil, l.unidade) },
            { titulo: '', direita: true, celula: (l) => (podeMexer ? el('button', { class: 'btn pequeno perigo', onclick: () => lancamento('perda', l.produto_id) }, 'Lançar perda') : null) },
          ], [...a.vencidos, ...a.vencendo], { vazio: 'Nenhum lote perto do vencimento.' }))));
    }

    if (aba === 'movimentos') {
      const movimentos = await api.get('/estoque/movimentos?limite=200');
      return limpar(corpo, el('section', { class: 'cartao' }, tabela([
        { titulo: 'Quando', celula: (m) => dataHora(m.criado_em) },
        { titulo: 'Produto', celula: (m) => m.produto },
        { titulo: 'Tipo', celula: (m) => etiqueta(m.tipo, m.qtd_mil > 0 ? 'ok' : m.tipo === 'perda' ? 'erro' : m.tipo === 'venda' ? 'info' : 'aviso') },
        { titulo: 'Quantidade', direita: true, celula: (m) => el('span', { class: m.qtd_mil > 0 ? 'positivo' : 'negativo' }, `${m.qtd_mil > 0 ? '+' : ''}${qtd(m.qtd_mil, m.unidade)}`) },
        { titulo: 'Saldo', direita: true, celula: (m) => qtd(m.saldo_mil) },
        { titulo: 'Observação', celula: (m) => m.observacao ?? m.documento ?? '—' },
        { titulo: 'Quem', celula: (m) => m.usuario ?? '—' },
      ], movimentos, { vazio: 'Nenhum movimento ainda.' })));
    }

    const inventarios = await api.get('/estoque/inventarios');
    limpar(corpo, el('section', { class: 'cartao' }, tabela([
      { titulo: 'Inventário', celula: (i) => `#${i.id} · ${i.descricao}` },
      { titulo: 'Aberto em', celula: (i) => dataHora(i.criado_em) },
      { titulo: 'Itens', direita: true, celula: (i) => i.itens },
      { titulo: 'Situação', direita: true, celula: (i) => etiqueta(i.status, i.status === 'aplicado' ? 'ok' : i.status === 'cancelado' ? 'erro' : 'aviso') },
    ], inventarios, { aoClicar: (i) => abrirInventario(i.id), vazio: 'Nenhuma contagem registrada.' })));
  }

  /* ---------- lançamentos ---------- */
  const lancamento = (tipo, produto_id = null) => modal(
    { entrada: 'Entrada no estoque', perda: 'Registrar perda', ajuste: 'Acertar o saldo' }[tipo],
    (fechar) => {
      const busca = el('input', { placeholder: 'Buscar o produto', autofocus: !produto_id });
      const seletor = el('select', { name: 'produto_id', required: true });
      const carregar = async (termo = '') => {
        const lista = await api.get(`/produtos?busca=${encodeURIComponent(termo)}&limite=50`);
        limpar(seletor, opcoes(lista.map((p) => ({ id: p.id, nome: `${p.nome} (saldo ${qtd(p.estoque_mil, p.unidade)})` })), { selecionado: produto_id }));
      };
      busca.addEventListener('input', (e) => carregar(e.target.value));
      carregar();
      return el('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        await acao(e.target.querySelector('button[type=submit]'), async () => {
          await api.post(`/estoque/${tipo}`, lerForm(e.target));
          toast('Estoque atualizado.');
          fechar();
          recarregar();
        });
      } },
      el('label', { class: 'campo' }, 'Produto', busca),
      seletor,
      tipo === 'ajuste'
        ? el('label', { class: 'campo' }, 'Quantidade contada', el('input', { name: 'contado', inputmode: 'decimal', required: true }))
        : el('label', { class: 'campo' }, 'Quantidade', el('input', { name: 'quantidade', inputmode: 'decimal', required: true })),
      tipo === 'entrada' ? el('div', { class: 'duas' },
        el('label', { class: 'campo' }, 'Custo unitário (R$)', el('input', { name: 'custo', inputmode: 'decimal' })),
        el('label', { class: 'campo' }, 'Validade', el('input', { name: 'validade', type: 'date' }))) : null,
      tipo === 'perda'
        ? el('label', { class: 'campo' }, 'Motivo', el('input', { name: 'motivo', required: true, placeholder: 'Ex.: vencido, quebrado, consumido na loja' }))
        : el('label', { class: 'campo' }, 'Observação', el('input', { name: 'observacao', placeholder: 'opcional' })),
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
        el('button', { type: 'submit', class: 'btn primario' }, 'Confirmar')));
    });

  /* ---------- inventário ---------- */
  const novoInventario = async () => {
    const categorias = await api.get('/produtos/categorias');
    return modal('Novo inventário', (fechar) => el('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        await acao(e.target.querySelector('button[type=submit]'), async () => {
          const inv = await api.post('/estoque/inventarios', lerForm(e.target));
          fechar();
          recarregar();
          abrirInventario(inv.id);
        });
      },
    },
    el('p', { class: 'mudo' }, 'A contagem começa com o saldo atual de cada produto. Vá corrigindo o que encontrar na prateleira e aplique no fim.'),
    el('label', { class: 'campo' }, 'Descrição', el('input', { name: 'descricao', required: true, value: `Contagem de ${new Date().toLocaleDateString('pt-BR')}`, autofocus: true })),
    el('label', { class: 'campo' }, 'Limitar a uma categoria', el('select', { name: 'categoria_id' }, opcoes(categorias, { vazio: 'Todos os produtos' }))),
    el('div', { class: 'linha fim' },
      el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
      el('button', { type: 'submit', class: 'btn primario' }, 'Abrir contagem'))));
  };

  async function abrirInventario(id) {
    let inv = await api.get(`/estoque/inventarios/${id}`);
    await modal(`Inventário #${inv.id}`, (fechar) => {
      const corpo = el('div', {});
      const pintar = () => {
        const diferenca = inv.itens.reduce((s, i) => s + Math.round(((i.contado_mil - i.esperado_mil) * i.custo_centavos) / 1000), 0);
        limpar(corpo,
          el('div', { class: 'linha entre' },
            el('p', { class: 'mudo linha' }, inv.descricao, etiqueta(inv.status, inv.status === 'aplicado' ? 'ok' : inv.status === 'cancelado' ? 'erro' : 'aviso')),
            el('strong', { class: diferenca < 0 ? 'negativo' : 'positivo' }, `Diferença: ${dinheiro(diferenca)}`)),
          tabela([
            { titulo: 'Produto', celula: (i) => i.produto },
            { titulo: 'Sistema', direita: true, celula: (i) => qtd(i.esperado_mil, i.unidade) },
            { titulo: 'Contado', direita: true, celula: (i) => (inv.status !== 'aberto' ? qtd(i.contado_mil) : el('input', {
              inputmode: 'decimal', value: qtd(i.contado_mil), style: 'width: 92px; min-height: 34px; text-align: right',
              onchange: async (e) => {
                const atualizado = await api.patch(`/estoque/inventarios/${inv.id}/itens/${i.produto_id}`, { contado: e.target.value });
                inv = atualizado;
                pintar();
              },
            })) },
            { titulo: 'Diferença', direita: true, celula: (i) => el('span', { class: i.diferenca_mil === 0 ? 'mudo' : i.diferenca_mil > 0 ? 'positivo' : 'negativo' }, qtd(i.diferenca_mil)) },
          ], inv.itens, { vazio: 'Nenhum produto nesta contagem.' }),
          el('div', { class: 'linha fim' },
            el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Fechar'),
            inv.status === 'aberto' && podeMexer ? el('button', { class: 'btn perigo fantasma', onclick: async () => {
              if (!await confirmar('Cancelar a contagem?', 'Nada será alterado no estoque.', 'Cancelar contagem', true)) return;
              await api.post(`/estoque/inventarios/${inv.id}/cancelar`, {});
              fechar();
              recarregar();
            } }, 'Cancelar') : null,
            inv.status === 'aberto' && podeMexer ? el('button', { class: 'btn primario', onclick: async (e) => {
              if (!await confirmar('Aplicar a contagem?', 'Os saldos passam a ser os valores contados e cada diferença vira um movimento.', 'Aplicar')) return;
              await acao(e.target, async () => {
                const r = await api.post(`/estoque/inventarios/${inv.id}/aplicar`, {});
                toast(`${r.ajustes} produto(s) acertados · diferença ${dinheiro(r.diferenca_centavos)}`);
                fechar();
                recarregar();
              });
            } }, icone('check'), 'Aplicar contagem') : null));
      };
      pintar();
      return corpo;
    }, { largo: true });
  }

  await desenhar();
}
