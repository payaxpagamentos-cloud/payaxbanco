import { api } from '../api.js';
import { el, $, limpar, dinheiro, emReais, qtd, dataBr, dataHora, icone, tabela, modal, toast, acao, etiqueta, lerForm, opcoes, confirmar, indicador, paraCentavos } from '../ui.js';

/** Pedidos ao fornecedor, sugestão de reposição e recebimento da mercadoria. */
export default async function compras({ alvo, usuario, definirTitulo }) {
  const podeCancelar = ['admin', 'gerente'].includes(usuario.perfil);
  let aba = 'pedidos';
  const fornecedores = await api.get('/produtos/fornecedores');

  async function desenhar() {
    definirTitulo('Compras', 'Pedidos, recebimento e reposição');
    limpar(alvo,
      el('div', { class: 'linha entre' },
        el('div', { class: 'abas' }, [['pedidos', 'Pedidos'], ['sugestao', 'Sugestão de reposição']].map(([chave, rotulo]) =>
          el('button', { class: aba === chave ? 'ativa' : '', onclick: () => { aba = chave; desenhar(); } }, rotulo))),
        el('button', { class: 'btn primario', onclick: () => novoPedido() }, icone('mais'), 'Novo pedido')),
      el('div', { id: 'corpo' }));
    recarregar();
  }

  async function recarregar() {
    const corpo = $('#corpo');
    if (aba === 'sugestao') {
      const grupos = await api.get('/compras/sugestao');
      return limpar(corpo, grupos.length ? el('div', { class: 'coluna' }, grupos.map((g) => el('section', { class: 'cartao' },
        el('div', { class: 'linha entre' },
          el('h2', {}, g.fornecedor),
          el('div', { class: 'linha' }, etiqueta(dinheiro(g.total_centavos), 'info'),
            g.fornecedor_id ? el('button', { class: 'btn pequeno primario', onclick: async (e) => {
              await acao(e.target, async () => {
                const pedido = await api.post(`/compras/sugestao/${g.fornecedor_id}`, {});
                toast('Rascunho de pedido criado.');
                aba = 'pedidos';
                desenhar();
                abrirPedido(pedido.id);
              });
            } }, 'Gerar pedido') : null)),
        tabela([
          { titulo: 'Produto', celula: (i) => i.nome },
          { titulo: 'Saldo', direita: true, celula: (i) => qtd(i.estoque_mil, i.unidade) },
          { titulo: 'Mínimo', direita: true, celula: (i) => qtd(i.estoque_minimo_mil) },
          { titulo: 'Sugerido', direita: true, celula: (i) => el('strong', {}, qtd(i.sugerido_mil, i.unidade)) },
          { titulo: 'Custo estimado', direita: true, celula: (i) => dinheiro(i.total_centavos) },
        ], g.itens))))
        : el('div', { class: 'cartao' }, el('div', { class: 'vazio' }, el('span', { class: 'icone' }, '✅'), 'Nenhum produto abaixo do mínimo. Estoque em dia!')));
    }

    const lista = await api.get('/compras');
    limpar(corpo, el('section', { class: 'cartao' }, tabela([
      { titulo: 'Pedido', celula: (c) => `#${c.id}${c.numero_nota ? ` · NF ${c.numero_nota}` : ''}` },
      { titulo: 'Fornecedor', celula: (c) => c.fornecedor },
      { titulo: 'Criado', celula: (c) => dataHora(c.criada_em) },
      { titulo: 'Previsão', celula: (c) => dataBr(c.previsao) },
      { titulo: 'Itens', direita: true, celula: (c) => c.itens },
      { titulo: 'Total', direita: true, celula: (c) => dinheiro(c.total_centavos) },
      { titulo: 'Situação', direita: true, celula: (c) => etiqueta(c.status, c.status === 'recebida' ? 'ok' : c.status === 'cancelada' ? 'erro' : c.status === 'enviada' ? 'info' : 'aviso') },
    ], lista, { aoClicar: (c) => abrirPedido(c.id), vazio: 'Nenhum pedido registrado.' })));
  }

  /* ---------- novo pedido ---------- */
  const novoPedido = () => modal('Novo pedido de compra', (fechar) => {
    const itens = [];
    const listaItens = el('div', { class: 'coluna' });
    const seletor = el('select', { required: true });
    const quantidade = el('input', { inputmode: 'decimal', placeholder: 'Qtd.', style: 'max-width: 110px' });
    const custo = el('input', { inputmode: 'decimal', placeholder: 'Custo R$', style: 'max-width: 130px' });
    let produtos = [];

    const carregarProdutos = async (termo = '') => {
      produtos = await api.get(`/produtos?busca=${encodeURIComponent(termo)}&limite=60`);
      limpar(seletor, opcoes(produtos.map((p) => ({ id: p.id, nome: `${p.nome} · custo ${dinheiro(p.custo_centavos)}` }))));
    };
    carregarProdutos();

    const pintarItens = () => limpar(listaItens, itens.length ? tabela([
      { titulo: 'Produto', celula: (i) => i.nome },
      { titulo: 'Qtd.', direita: true, celula: (i) => qtd(i.qtd_mil) },
      { titulo: 'Custo', direita: true, celula: (i) => dinheiro(i.custo_centavos) },
      { titulo: 'Total', direita: true, celula: (i) => dinheiro(Math.round((i.qtd_mil * i.custo_centavos) / 1000)) },
      { titulo: '', direita: true, celula: (i) => el('button', { class: 'btn icone fantasma', onclick: () => { itens.splice(itens.indexOf(i), 1); pintarItens(); } }, icone('x')) },
    ], itens) : el('p', { class: 'mudo pequeno' }, 'Nenhum item no pedido ainda.'));
    pintarItens();

    return el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      if (!itens.length) return toast('Adicione ao menos um item.', 'erro');
      const d = lerForm(e.target);
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        const pedido = await api.post('/compras', {
          ...d,
          itens: itens.map((i) => ({ produto_id: i.produto_id, quantidade: qtd(i.qtd_mil), custo: emReais(i.custo_centavos) })),
        });
        toast('Pedido criado.');
        fechar();
        recarregar();
        abrirPedido(pedido.id);
      });
    } },
    el('div', { class: 'duas' },
      el('label', { class: 'campo' }, 'Fornecedor', el('select', { name: 'fornecedor_id', required: true }, opcoes(fornecedores.filter((f) => f.ativo)))),
      el('label', { class: 'campo' }, 'Previsão de entrega', el('input', { name: 'previsao', type: 'date' }))),
    el('div', { class: 'tres' },
      el('label', { class: 'campo' }, 'Parcelas', el('input', { name: 'parcelas', type: 'number', min: 1, max: 12, value: 1 })),
      el('label', { class: 'campo' }, 'Frete (R$)', el('input', { name: 'frete', inputmode: 'decimal' })),
      el('label', { class: 'campo' }, 'Desconto (R$)', el('input', { name: 'desconto', inputmode: 'decimal' }))),
    el('h3', {}, 'Itens'),
    el('input', { placeholder: 'Buscar produto', oninput: (e) => carregarProdutos(e.target.value) }),
    el('div', { class: 'linha' }, seletor, quantidade, custo,
      el('button', { type: 'button', class: 'btn', onclick: () => {
        const produto = produtos.find((p) => String(p.id) === seletor.value);
        if (!produto || !quantidade.value) return toast('Escolha o produto e a quantidade.', 'erro');
        itens.push({
          produto_id: produto.id, nome: produto.nome,
          qtd_mil: Math.round(Number(quantidade.value.replace(',', '.')) * 1000),
          custo_centavos: custo.value ? paraCentavos(custo.value) : produto.custo_centavos,
        });
        quantidade.value = ''; custo.value = '';
        pintarItens();
      } }, icone('mais'), 'Incluir')),
    listaItens,
    el('label', { class: 'campo' }, 'Observação', el('input', { name: 'observacao' })),
    el('div', { class: 'linha fim' },
      el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
      el('button', { type: 'submit', class: 'btn primario' }, 'Criar pedido')));
  }, { largo: true });

  /* ---------- pedido aberto ---------- */
  async function abrirPedido(id) {
    const c = await api.get(`/compras/${id}`);
    await modal(`Pedido #${c.id} · ${c.fornecedor}`, (fechar) => [
      el('div', { class: 'grade' },
        indicador({ simbolo: 'compras', rotulo: 'Total', valor: dinheiro(c.total_centavos), nota: `${c.parcelas}x` }),
        indicador({ rotulo: 'Situação', valor: c.status, nota: c.recebida_em ? `recebido em ${dataHora(c.recebida_em)}` : c.previsao ? `previsão ${dataBr(c.previsao)}` : '' }),
        indicador({ rotulo: 'Itens', valor: String(c.itens.length), nota: c.numero_nota ? `NF ${c.numero_nota}` : '' })),
      tabela([
        { titulo: 'Produto', celula: (i) => i.produto },
        { titulo: 'Pedido', direita: true, celula: (i) => qtd(i.qtd_mil, i.unidade) },
        { titulo: 'Recebido', direita: true, celula: (i) => (i.recebido_mil === null ? '—' : qtd(i.recebido_mil, i.unidade)) },
        { titulo: 'Custo', direita: true, celula: (i) => dinheiro(i.custo_centavos) },
        { titulo: 'Validade', celula: (i) => dataBr(i.validade) },
        { titulo: 'Total', direita: true, celula: (i) => dinheiro(i.total_centavos) },
      ], c.itens),
      c.observacao ? el('p', { class: 'pequeno mudo' }, c.observacao) : null,
      el('div', { class: 'linha fim' },
        el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Fechar'),
        c.status === 'rascunho' ? el('button', { class: 'btn', onclick: async (e) => {
          await acao(e.target, async () => { await api.post(`/compras/${c.id}/enviar`, {}); toast('Pedido marcado como enviado.'); fechar(); recarregar(); });
        } }, icone('check'), 'Marcar como enviado') : null,
        podeCancelar && ['rascunho', 'enviada'].includes(c.status) ? el('button', { class: 'btn perigo fantasma', onclick: async () => {
          const motivo = await confirmar('Cancelar o pedido?', 'O pedido fica registrado como cancelado e não entra no estoque.', 'Cancelar pedido', true);
          if (!motivo) return;
          await api.post(`/compras/${c.id}/cancelar`, { motivo: 'Cancelado pela gestão' });
          fechar();
          recarregar();
        } }, 'Cancelar') : null,
        ['rascunho', 'enviada'].includes(c.status) ? el('button', { class: 'btn primario', onclick: () => { fechar(); receber(c); } }, icone('compras'), 'Receber mercadoria') : null),
    ], { largo: true });
  }

  /* ---------- recebimento ---------- */
  const receber = (c) => modal(`Receber o pedido #${c.id}`, (fechar) => {
    const campos = c.itens.map((i) => ({
      item: i,
      recebido: el('input', { inputmode: 'decimal', value: qtd(i.qtd_mil), style: 'min-height: 36px' }),
      custo: el('input', { inputmode: 'decimal', value: emReais(i.custo_centavos), style: 'min-height: 36px' }),
      validade: el('input', { type: 'date', value: i.validade ?? '', style: 'min-height: 36px' }),
      preco: el('input', { inputmode: 'decimal', value: i.preco_sugerido_centavos ? emReais(i.preco_sugerido_centavos) : '', placeholder: emReais(i.preco_atual_centavos), style: 'min-height: 36px' }),
    }));
    // Sugere o preço de venda assim que o custo do recebimento muda.
    for (const campo of campos) {
      campo.custo.addEventListener('change', async () => {
        const r = await api.get(`/compras/sugerir-preco/${paraCentavos(campo.custo.value)}`);
        campo.preco.placeholder = emReais(r.preco_centavos);
      });
    }
    return el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.post(`/compras/${c.id}/receber`, {
          numero_nota: e.target.numero_nota.value || null,
          itens: campos.map((campo) => ({
            item_id: campo.item.id,
            recebido: campo.recebido.value,
            custo: campo.custo.value,
            validade: campo.validade.value || null,
            preco_venda: campo.preco.value || null,
          })),
        });
        toast('Mercadoria recebida: estoque e contas a pagar atualizados.');
        fechar();
        recarregar();
      });
    } },
    el('p', { class: 'mudo' }, 'Confira o que chegou. O custo entra no custo médio do produto e as parcelas viram contas a pagar.'),
    el('label', { class: 'campo' }, 'Número da nota', el('input', { name: 'numero_nota', value: c.numero_nota ?? '' })),
    el('div', { class: 'tabela-rolagem' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Produto', 'Recebido', 'Custo R$', 'Validade', 'Novo preço R$'].map((t) => el('th', {}, t)))),
      el('tbody', {}, campos.map((campo) => el('tr', {},
        el('td', {}, campo.item.produto),
        el('td', {}, campo.recebido),
        el('td', {}, campo.custo),
        el('td', {}, campo.validade),
        el('td', {}, campo.preco)))))),
    el('div', { class: 'linha fim' },
      el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
      el('button', { type: 'submit', class: 'btn primario' }, icone('check'), 'Dar entrada no estoque')));
  }, { largo: true });

  await desenhar();
}
