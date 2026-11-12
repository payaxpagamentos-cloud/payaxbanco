import { api } from '../api.js';
import { el, $, limpar, dinheiro, emReais, qtd, percentual, dataBr, dataHora, icone, tabela, modal, toast, acao, etiqueta, lerForm, opcoes, fotoProduto, reduzirImagem, UNIDADES } from '../ui.js';

/** Cadastro de produtos, categorias e fornecedores. */
export default async function produtos({ alvo, usuario, definirTitulo }) {
  const podeEditar = ['admin', 'gerente', 'estoque'].includes(usuario.perfil);
  let aba = 'produtos';
  let filtros = { busca: '', categoria_id: '', situacao: 'ativos', ordem: 'nome' };
  const [categorias, fornecedores] = await Promise.all([api.get('/produtos/categorias'), api.get('/produtos/fornecedores')]);

  async function desenhar() {
    definirTitulo('Produtos', 'Cadastro, preços e margem');
    limpar(alvo,
      el('div', { class: 'linha entre' },
        el('div', { class: 'abas' }, [['produtos', 'Produtos'], ['categorias', 'Categorias'], ['fornecedores', 'Fornecedores']].map(([chave, rotulo]) =>
          el('button', { class: aba === chave ? 'ativa' : '', onclick: () => { aba = chave; desenhar(); } }, rotulo))),
        podeEditar ? el('div', { class: 'linha' },
          aba === 'produtos' ? el('button', { class: 'btn', onclick: reajuste }, icone('financeiro'), 'Reajustar preços') : null,
          el('button', { class: 'btn primario', onclick: () => (aba === 'produtos' ? editarProduto() : aba === 'categorias' ? editarCategoria() : editarFornecedor()) },
            icone('mais'), aba === 'produtos' ? 'Novo produto' : aba === 'categorias' ? 'Nova categoria' : 'Novo fornecedor')) : null),
      el('div', { id: 'lista' }));
    recarregar();
  }

  async function recarregar() {
    const alvoLista = $('#lista');
    if (aba === 'categorias') {
      const lista = await api.get('/produtos/categorias');
      return limpar(alvoLista, el('section', { class: 'cartao' }, tabela([
        { titulo: 'Categoria', celula: (c) => el('span', { class: 'linha' }, el('span', { class: 'ponto', style: `color: ${c.cor}` }), c.nome) },
        { titulo: 'Produtos', direita: true, celula: (c) => c.produtos },
        { titulo: 'Situação', direita: true, celula: (c) => etiqueta(c.ativa ? 'ativa' : 'inativa', c.ativa ? 'ok' : null) },
      ], lista, { aoClicar: podeEditar ? editarCategoria : null })));
    }
    if (aba === 'fornecedores') {
      const lista = await api.get('/produtos/fornecedores');
      return limpar(alvoLista, el('section', { class: 'cartao' }, tabela([
        { titulo: 'Fornecedor', celula: (f) => f.nome },
        { titulo: 'Contato', celula: (f) => f.contato ?? f.telefone ?? '—' },
        { titulo: 'Produtos', direita: true, celula: (f) => f.produtos },
        { titulo: 'Prazo de pagamento', direita: true, celula: (f) => `${f.prazo_pagamento_dias} dias` },
        { titulo: 'Em aberto', direita: true, celula: (f) => dinheiro(f.a_pagar_centavos) },
        { titulo: '', direita: true, celula: (f) => etiqueta(f.ativo ? 'ativo' : 'inativo', f.ativo ? 'ok' : null) },
      ], lista, { aoClicar: podeEditar ? editarFornecedor : null })));
    }

    const params = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v));
    const lista = await api.get(`/produtos?${params}`);
    limpar(alvoLista,
      el('section', { class: 'cartao' },
        el('div', { class: 'linha', style: 'margin-bottom: 14px' },
          el('input', { class: 'crescer', placeholder: 'Buscar por nome ou código de barras', value: filtros.busca, oninput: (e) => { filtros.busca = e.target.value; recarregar(); } }),
          el('select', { style: 'width: auto', onchange: (e) => { filtros.categoria_id = e.target.value; recarregar(); } },
            opcoes(categorias, { selecionado: filtros.categoria_id, vazio: 'Todas as categorias' })),
          el('select', { style: 'width: auto', onchange: (e) => { filtros.situacao = e.target.value; recarregar(); } },
            opcoes([{ id: 'ativos', nome: 'Ativos' }, { id: 'baixo', nome: 'Abaixo do mínimo' }, { id: 'inativos', nome: 'Inativos' }, { id: 'todos', nome: 'Todos' }], { selecionado: filtros.situacao })),
          el('select', { style: 'width: auto', onchange: (e) => { filtros.ordem = e.target.value; recarregar(); } },
            opcoes([{ id: 'nome', nome: 'Por nome' }, { id: 'estoque', nome: 'Por estoque' }, { id: 'preco', nome: 'Por preço' }, { id: 'recentes', nome: 'Mais recentes' }], { selecionado: filtros.ordem }))),
        tabela([
          { titulo: 'Produto', celula: (p) => el('span', { class: 'linha', style: 'flex-wrap: nowrap' },
            fotoProduto(p, { classe: 'foto-produto miniatura' }),
            el('span', {}, el('div', { class: 'destaque' }, p.nome),
              el('div', { class: 'pequeno mudo' }, `${p.codigo_barras ?? 'sem código'}${p.categoria ? ` · ${p.categoria}` : ''}`))) },
          { titulo: 'Estoque', direita: true, celula: (p) => el('span', { class: p.estoque_mil <= p.estoque_minimo_mil ? 'negativo' : '' }, qtd(p.estoque_mil, p.unidade)) },
          { titulo: 'Custo', direita: true, celula: (p) => dinheiro(p.custo_centavos) },
          { titulo: 'Venda', direita: true, celula: (p) => el('strong', {}, dinheiro(p.preco_centavos)) },
          { titulo: 'Margem', direita: true, celula: (p) => (p.margem_bp === null ? '—' : percentual(p.margem_bp)) },
          { titulo: '', direita: true, celula: (p) => (p.ativo ? '' : etiqueta('inativo')) },
        ], lista, { aoClicar: ficha, vazio: 'Nenhum produto com esses filtros.' })));
  }

  /* ---------- ficha do produto ---------- */
  async function ficha(produto) {
    const p = await api.get(`/produtos/${produto.id}`);
    await modal(p.nome, (fechar) => [
      el('div', { class: 'linha', style: 'align-items: flex-start' },
        fotoProduto(p, { classe: 'foto-produto grande' }),
        el('div', { class: 'crescer pequeno mudo' },
          el('div', {}, p.codigo_barras ?? 'sem código de barras'),
          el('div', {}, [p.categoria, p.fornecedor].filter(Boolean).join(' · ') || 'sem categoria'),
          p.foto ? null : el('div', { class: 'etiqueta aviso', style: 'margin-top: 8px' }, 'sem foto cadastrada'))),
      el('div', { class: 'grade' },
        el('div', { class: 'cartao indicador sem-brilho' }, el('span', { class: 'rotulo' }, 'Preço de venda'), el('span', { class: 'valor' }, dinheiro(p.preco_centavos))),
        el('div', { class: 'cartao indicador sem-brilho' }, el('span', { class: 'rotulo' }, 'Custo médio'), el('span', { class: 'valor' }, dinheiro(p.custo_centavos)),
          el('span', { class: 'nota' }, p.margem_bp === null ? '' : `margem ${percentual(p.margem_bp)}`)),
        el('div', { class: 'cartao indicador sem-brilho' }, el('span', { class: 'rotulo' }, 'Em estoque'), el('span', { class: 'valor' }, qtd(p.estoque_mil, p.unidade)),
          el('span', { class: 'nota' }, `mínimo ${qtd(p.estoque_minimo_mil)}`)),
        el('div', { class: 'cartao indicador sem-brilho' }, el('span', { class: 'rotulo' }, 'Vendas em 30 dias'), el('span', { class: 'valor' }, dinheiro(p.vendas_30_dias.total_centavos)),
          el('span', { class: 'nota' }, qtd(p.vendas_30_dias.qtd_mil, p.unidade)))),
      p.lotes.length ? el('div', {}, el('h3', {}, 'Lotes com validade'), tabela([
        { titulo: 'Validade', celula: (l) => dataBr(l.validade) },
        { titulo: 'Quantidade', direita: true, celula: (l) => qtd(l.qtd_mil, p.unidade) },
      ], p.lotes)) : null,
      el('h3', {}, 'Últimos movimentos'),
      tabela([
        { titulo: 'Quando', celula: (m) => dataHora(m.criado_em) },
        { titulo: 'Tipo', celula: (m) => etiqueta(m.tipo, m.qtd_mil > 0 ? 'ok' : m.tipo === 'perda' ? 'erro' : null) },
        { titulo: 'Qtd.', direita: true, celula: (m) => qtd(m.qtd_mil, p.unidade) },
        { titulo: 'Saldo', direita: true, celula: (m) => qtd(m.saldo_mil) },
        { titulo: 'Observação', celula: (m) => m.observacao ?? m.documento ?? '—' },
      ], p.movimentos, { vazio: 'Sem movimentos.' }),
      el('div', { class: 'linha fim' },
        el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Fechar'),
        podeEditar ? el('button', { class: 'btn primario', onclick: () => { fechar(); editarProduto(p); } }, icone('editar'), 'Editar produto') : null),
    ], { largo: true });
  }

  /* ---------- formulários ---------- */
  const editarProduto = (p = null) => modal(p ? 'Editar produto' : 'Novo produto', (fechar) => {
    // A foto é enviada depois de salvar (um produto novo só tem id depois de criado).
    let novaFoto = null;
    let removerFoto = false;
    const previa = el('div', { class: 'previa-foto' }, fotoProduto(p ?? {}, { classe: 'foto-produto grande' }));
    const escolher = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'oculto', onchange: async (e) => {
      const arquivo = e.target.files?.[0];
      e.target.value = '';
      if (!arquivo) return;
      try {
        novaFoto = await reduzirImagem(arquivo);
        removerFoto = false;
        limpar(previa, el('img', { class: 'foto-produto grande', src: URL.createObjectURL(novaFoto), alt: '' }));
        pintarBotoes();
      } catch (err) {
        toast(err.message, 'erro');
      }
    } });
    const botoes = el('div', { class: 'linha' });
    const pintarBotoes = () => limpar(botoes,
      el('button', { type: 'button', class: 'btn pequeno', onclick: () => escolher.click() }, icone('produtos'), novaFoto || (p?.foto && !removerFoto) ? 'Trocar foto' : 'Escolher foto'),
      (novaFoto || (p?.foto && !removerFoto)) ? el('button', { type: 'button', class: 'btn pequeno perigo', onclick: () => {
        novaFoto = null;
        removerFoto = Boolean(p?.foto);
        limpar(previa, fotoProduto({ nome: p?.nome }, { classe: 'foto-produto grande' }));
        pintarBotoes();
      } }, 'Remover') : null);
    pintarBotoes();
    const campoFoto = el('div', { class: 'linha', style: 'align-items: center' }, previa,
      el('div', { class: 'crescer' },
        el('div', { class: 'pequeno mudo', style: 'margin-bottom: 8px' }, 'A foto aparece no terminal do cliente e nesta lista. A imagem é reduzida automaticamente antes de subir.'),
        botoes, escolher));

    /** Depois de salvar o cadastro, envia ou apaga a foto. */
    const salvarFoto = async (id) => {
      if (novaFoto) await api.enviarArquivo(`/produtos/${id}/foto`, novaFoto);
      else if (removerFoto) await api.delete(`/produtos/${id}/foto`);
    };

    const custo = el('input', { name: 'custo', inputmode: 'decimal', value: p ? emReais(p.custo_centavos) : '' });
    const preco = el('input', { name: 'preco', inputmode: 'decimal', value: p ? emReais(p.preco_centavos) : '', required: true });
    const sugerir = async () => {
      if (!custo.value) return;
      const r = await api.get(`/produtos/sugerir-preco?custo=${encodeURIComponent(custo.value)}`);
      preco.value = emReais(r.preco_centavos);
    };
    return el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      d.pesavel = e.target.pesavel.checked;
      d.controla_validade = e.target.controla_validade.checked;
      if (p) d.ativo = e.target.ativo.checked;
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        const salvo = p ? await api.patch(`/produtos/${p.id}`, d) : await api.post('/produtos', d);
        await salvarFoto(salvo.id ?? p.id);
        toast(p ? 'Produto atualizado.' : 'Produto cadastrado.');
        fechar();
        recarregar();
      });
    } },
    campoFoto,
    el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', required: true, value: p?.nome ?? '', autofocus: true, placeholder: 'Ex.: Arroz branco tipo 1 - 5 kg' })),
    el('div', { class: 'duas' },
      el('label', { class: 'campo' }, 'Código de barras', el('input', { name: 'codigo_barras', inputmode: 'numeric', value: p?.codigo_barras ?? '', placeholder: 'bipe aqui' })),
      el('label', { class: 'campo' }, 'Unidade', el('select', { name: 'unidade' }, opcoes(Object.entries(UNIDADES).map(([id, nome]) => ({ id, nome })), { selecionado: p?.unidade ?? 'un' })))),
    el('div', { class: 'duas' },
      el('label', { class: 'campo' }, 'Categoria', el('select', { name: 'categoria_id' }, opcoes(categorias, { selecionado: p?.categoria_id, vazio: 'Sem categoria' }))),
      el('label', { class: 'campo' }, 'Fornecedor', el('select', { name: 'fornecedor_id' }, opcoes(fornecedores, { selecionado: p?.fornecedor_id, vazio: 'Sem fornecedor' })))),
    el('div', { class: 'duas' },
      el('label', { class: 'campo' }, 'Custo (R$)', custo),
      el('label', { class: 'campo' }, el('span', { class: 'linha entre' }, 'Preço de venda (R$)',
        el('button', { type: 'button', class: 'acao-campo', onclick: sugerir }, 'sugerir')), preco)),
    el('div', { class: 'duas' },
      el('label', { class: 'campo' }, 'Estoque mínimo', el('input', { name: 'estoque_minimo', inputmode: 'decimal', value: p ? qtd(p.estoque_minimo_mil) : '0' })),
      p ? null : el('label', { class: 'campo' }, 'Estoque inicial', el('input', { name: 'estoque', inputmode: 'decimal', value: '0' }))),
    p ? null : el('label', { class: 'campo' }, 'Validade do lote inicial', el('input', { name: 'validade', type: 'date' })),
    el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'pesavel', checked: p?.pesavel ? true : null }), 'Vendido por peso (balança)'),
    el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'controla_validade', checked: p?.controla_validade ? true : null }), 'Controlar validade por lote'),
    p ? el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'ativo', checked: p.ativo ? true : null }), 'Produto ativo (aparece no PDV)') : null,
    el('div', { class: 'linha fim' },
      el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
      el('button', { type: 'submit', class: 'btn primario' }, p ? 'Salvar' : 'Cadastrar')));
  });

  const editarCategoria = (c = null) => modal(c ? 'Editar categoria' : 'Nova categoria', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      if (c) d.ativa = e.target.ativa.checked;
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        if (c) await api.patch(`/produtos/categorias/${c.id}`, d);
        else await api.post('/produtos/categorias', d);
        toast('Categoria salva.');
        fechar();
        recarregar();
      });
    },
  },
  el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', required: true, value: c?.nome ?? '', autofocus: true })),
  el('label', { class: 'campo' }, 'Cor', el('input', { name: 'cor', type: 'color', value: c?.cor ?? '#6E8BFF', style: 'height: 46px' })),
  c ? el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'ativa', checked: c.ativa ? true : null }), 'Categoria ativa') : null,
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Salvar'))));

  const editarFornecedor = (f = null) => modal(f ? 'Editar fornecedor' : 'Novo fornecedor', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      if (f) d.ativo = e.target.ativo.checked;
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        if (f) await api.patch(`/produtos/fornecedores/${f.id}`, d);
        else await api.post('/produtos/fornecedores', d);
        toast('Fornecedor salvo.');
        fechar();
        recarregar();
      });
    },
  },
  el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', required: true, value: f?.nome ?? '', autofocus: true })),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'CNPJ', el('input', { name: 'cnpj', inputmode: 'numeric', value: f?.cnpj ?? '' })),
    el('label', { class: 'campo' }, 'Telefone', el('input', { name: 'telefone', inputmode: 'tel', value: f?.telefone ?? '' }))),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Contato', el('input', { name: 'contato', value: f?.contato ?? '' })),
    el('label', { class: 'campo' }, 'E-mail', el('input', { name: 'email', type: 'email', value: f?.email ?? '' }))),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Prazo de entrega (dias)', el('input', { name: 'prazo_entrega_dias', type: 'number', min: 0, value: f?.prazo_entrega_dias ?? 3 })),
    el('label', { class: 'campo' }, 'Prazo de pagamento (dias)', el('input', { name: 'prazo_pagamento_dias', type: 'number', min: 0, value: f?.prazo_pagamento_dias ?? 28 }))),
  el('label', { class: 'campo' }, 'Observação', el('textarea', { name: 'observacao' }, f?.observacao ?? '')),
  f ? el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'ativo', checked: f.ativo ? true : null }), 'Fornecedor ativo') : null,
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Salvar'))));

  const reajuste = () => modal('Reajustar preços', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        const r = await api.post('/produtos/reajuste', lerForm(e.target));
        toast(`${r.produtos} produto(s) reajustados em ${r.percentual}%.`);
        fechar();
        recarregar();
      });
    },
  },
  el('p', { class: 'mudo' }, 'Aplica um percentual sobre o preço de venda atual. Use valor negativo para baixar o preço.'),
  el('label', { class: 'campo' }, 'Categoria', el('select', { name: 'categoria_id' }, opcoes(categorias, { vazio: 'Escolha a categoria' }))),
  el('label', { class: 'campo' }, 'Ou fornecedor', el('select', { name: 'fornecedor_id' }, opcoes(fornecedores, { vazio: 'Escolha o fornecedor' }))),
  el('label', { class: 'campo' }, 'Percentual (%)', el('input', { name: 'percentual', inputmode: 'decimal', required: true, placeholder: 'Ex.: 5 ou -3' })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Reajustar'))));

  await desenhar();
}
