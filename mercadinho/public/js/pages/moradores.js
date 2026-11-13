import { api } from '../api.js';
import { el, $, limpar, dinheiro, emReais, dataBr, dataHora, icone, indicador, tabela, modal, toast, acao, etiqueta, lerForm, opcoes, competenciaAtual, mesPorExtenso } from '../ui.js';

/** Moradores, conta do mês (fiado), faturas e acesso ao portal. */
export default async function moradores({ alvo, usuario, definirTitulo }) {
  const gestao = ['admin', 'gerente'].includes(usuario.perfil);
  let aba = 'moradores';
  let filtros = { busca: '', situacao: 'ativos', devedores: false };

  async function desenhar() {
    definirTitulo('Moradores', 'Conta do mês, limites e faturas');
    limpar(alvo,
      el('div', { class: 'linha entre' },
        el('div', { class: 'abas' }, [['moradores', 'Moradores'], ['faturas', 'Faturas']].map(([chave, rotulo]) =>
          el('button', { class: aba === chave ? 'ativa' : '', onclick: () => { aba = chave; desenhar(); } }, rotulo))),
        el('div', { class: 'linha' },
          aba === 'faturas' && gestao ? el('button', { class: 'btn', onclick: fecharMes }, icone('relogio'), 'Fechar o mês') : null,
          aba === 'moradores' ? el('button', { class: 'btn primario', onclick: () => editar() }, icone('mais'), 'Novo morador') : null)),
      el('div', { id: 'corpo' }));
    recarregar();
  }

  async function recarregar() {
    const corpo = $('#corpo');
    if (aba === 'faturas') {
      const lista = await api.get('/moradores/faturas');
      const abertas = lista.filter((f) => f.status === 'aberta');
      return limpar(corpo,
        el('div', { class: 'grade' },
          indicador({ simbolo: 'relatorios', cor: 'ambar', rotulo: 'Faturas em aberto', valor: String(abertas.length), nota: dinheiro(abertas.reduce((s, f) => s + f.valor_centavos, 0)) }),
          indicador({ simbolo: 'check', rotulo: 'Faturas emitidas', valor: String(lista.length) })),
        el('section', { class: 'cartao' }, tabela([
          { titulo: 'Competência', celula: (f) => mesPorExtenso(f.competencia) },
          { titulo: 'Morador', celula: (f) => `${f.morador} · ${f.bloco}/${f.unidade}` },
          { titulo: 'Compras', direita: true, celula: (f) => f.compras },
          { titulo: 'Vencimento', celula: (f) => dataBr(f.vencimento) },
          { titulo: 'Valor', direita: true, celula: (f) => el('strong', {}, dinheiro(f.valor_centavos)) },
          { titulo: 'Situação', direita: true, celula: (f) => etiqueta(f.status, f.status === 'paga' ? 'ok' : f.status === 'cancelada' ? 'erro' : 'aviso') },
        ], lista, { aoClicar: (f) => ficha(f.morador_id), vazio: 'Nenhuma fatura emitida. Use "Fechar o mês".' })));
    }

    const params = new URLSearchParams({ busca: filtros.busca, situacao: filtros.situacao, ...(filtros.devedores ? { devedores: '1' } : {}) });
    const lista = await api.get(`/moradores?${params}`);
    const devendo = lista.filter((m) => m.saldo_centavos > 0);
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ simbolo: 'moradores', cor: 'roxo', rotulo: 'Moradores cadastrados', valor: String(lista.length) }),
        indicador({ simbolo: 'alerta', cor: devendo.length ? 'vermelho' : 'ambar', rotulo: 'Com conta em aberto', valor: String(devendo.length), nota: dinheiro(devendo.reduce((s, m) => s + m.saldo_centavos, 0)), tom: devendo.length ? 'vermelho' : null })),
      el('section', { class: 'cartao' },
        el('div', { class: 'linha', style: 'margin-bottom: 12px' },
          el('input', { class: 'crescer', placeholder: 'Buscar por nome, bloco ou apartamento', value: filtros.busca, oninput: (e) => { filtros.busca = e.target.value; recarregar(); } }),
          el('select', { style: 'width: auto', onchange: (e) => { filtros.situacao = e.target.value; recarregar(); } },
            opcoes([{ id: 'ativos', nome: 'Ativos' }, { id: 'inativos', nome: 'Inativos' }, { id: 'todos', nome: 'Todos' }], { selecionado: filtros.situacao })),
          el('label', { class: 'marcador' }, el('input', { type: 'checkbox', checked: filtros.devedores ? true : null, onchange: (e) => { filtros.devedores = e.target.checked; recarregar(); } }), 'Só quem deve')),
        tabela([
          { titulo: 'Morador', celula: (m) => el('span', {}, el('div', { class: 'destaque' }, m.nome), el('div', { class: 'pequeno mudo' }, `Bloco ${m.bloco} · unidade ${m.unidade}`)) },
          { titulo: 'Saldo', direita: true, celula: (m) => el('strong', { class: m.saldo_centavos > 0 ? 'negativo' : 'positivo' }, dinheiro(m.saldo_centavos)) },
          { titulo: 'Limite', direita: true, celula: (m) => el('span', {}, dinheiro(m.limite_centavos), m.limite_proprio ? '' : el('span', { class: 'pequeno mudo' }, ' (padrão)')) },
          { titulo: 'Disponível', direita: true, celula: (m) => el('div', { class: 'barra', style: 'width: 90px; margin-left: auto' },
            el('span', { style: `width: ${Math.min(100, (m.disponivel_centavos / Math.max(1, m.limite_centavos)) * 100)}%` })) },
          { titulo: '', direita: true, celula: (m) => (m.fiado_liberado ? (m.ativo ? '' : etiqueta('inativo')) : etiqueta('sem fiado', 'aviso')) },
        ], lista, { aoClicar: (m) => ficha(m.id), vazio: 'Nenhum morador cadastrado.' })));
  }

  /* ---------- ficha ---------- */
  async function ficha(id) {
    const m = await api.get(`/moradores/${id}`);
    await modal(`${m.nome} · ${m.bloco}/${m.unidade}`, (fechar) => [
      el('div', { class: 'grade' },
        indicador({ simbolo: 'dinheiro', cor: m.saldo_centavos > 0 ? 'vermelho' : '', rotulo: 'Saldo devedor', valor: dinheiro(m.saldo_centavos), tom: m.saldo_centavos > 0 ? 'vermelho' : 'verde' }),
        indicador({ simbolo: 'cartao', cor: 'azul', rotulo: 'Limite', valor: dinheiro(m.limite_centavos), nota: `disponível ${dinheiro(m.disponivel_centavos)}` }),
        indicador({ simbolo: 'compras', cor: 'roxo', rotulo: 'Consumo do mês', valor: dinheiro(m.consumo_do_mes.total_centavos), nota: `${m.consumo_do_mes.compras} compra(s)` })),
      el('p', { class: 'pequeno mudo' }, [m.telefone, m.email, m.acesso ? `portal: ${m.acesso.email}` : 'sem acesso ao portal', m.observacao].filter(Boolean).join(' · ')),
      el('p', { class: 'linha pequeno' }, 'Terminal do balcão:',
        m.tem_pin ? etiqueta('senha cadastrada', 'ok') : etiqueta('sem senha — não compra na conta pelo terminal', 'aviso')),
      el('div', { class: 'linha' },
        el('button', { class: 'btn primario pequeno', onclick: () => { fechar(); receber(m); } }, icone('dinheiro'), 'Receber pagamento'),
        el('button', { class: 'btn pequeno', onclick: () => { fechar(); editar(m); } }, icone('editar'), 'Editar'),
        gestao ? el('button', { class: 'btn pequeno', onclick: () => { fechar(); senhaTerminal(m); } }, icone('caixa'), m.tem_pin ? 'Trocar senha do terminal' : 'Criar senha do terminal') : null,
        gestao ? el('button', { class: 'btn pequeno', onclick: () => { fechar(); ajuste(m); } }, 'Ajuste manual') : null,
        gestao ? el('button', { class: 'btn pequeno', onclick: () => { fechar(); acesso(m); } }, icone('usuarios'), m.acesso ? 'Trocar acesso' : 'Criar acesso') : null),
      m.faturas.length ? el('div', {}, el('h3', {}, 'Faturas'), tabela([
        { titulo: 'Competência', celula: (f) => mesPorExtenso(f.competencia) },
        { titulo: 'Vencimento', celula: (f) => dataBr(f.vencimento) },
        { titulo: 'Valor', direita: true, celula: (f) => dinheiro(f.valor_centavos) },
        { titulo: 'Situação', direita: true, celula: (f) => etiqueta(f.status, f.status === 'paga' ? 'ok' : 'aviso') },
      ], m.faturas)) : null,
      el('h3', {}, 'Extrato da conta'),
      tabela([
        { titulo: 'Quando', celula: (l) => dataHora(l.criado_em) },
        { titulo: 'Lançamento', celula: (l) => l.descricao },
        { titulo: 'Tipo', celula: (l) => etiqueta(l.tipo, l.valor_centavos > 0 ? 'aviso' : 'ok') },
        { titulo: 'Valor', direita: true, celula: (l) => el('span', { class: l.valor_centavos > 0 ? 'negativo' : 'positivo' }, dinheiro(l.valor_centavos)) },
      ], m.extrato, { vazio: 'Nenhum lançamento na conta.' }),
      el('div', { class: 'linha fim' }, el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Fechar')),
    ], { largo: true });
  }

  const editar = (m = null) => modal(m ? 'Editar morador' : 'Novo morador', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      d.fiado_liberado = e.target.fiado_liberado.checked;
      if (m) d.ativo = e.target.ativo.checked;
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        if (m) await api.patch(`/moradores/${m.id}`, d);
        else await api.post('/moradores', d);
        toast('Morador salvo.');
        fechar();
        recarregar();
      });
    },
  },
  el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', required: true, value: m?.nome ?? '', autofocus: true })),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Bloco', el('input', { name: 'bloco', value: m?.bloco ?? '', placeholder: 'A' })),
    el('label', { class: 'campo' }, 'Unidade (apartamento)', el('input', { name: 'unidade', required: true, value: m?.unidade ?? '', placeholder: '101' }))),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Telefone', el('input', { name: 'telefone', inputmode: 'tel', value: m?.telefone ?? '' })),
    el('label', { class: 'campo' }, 'E-mail', el('input', { name: 'email', type: 'email', value: m?.email ?? '' }))),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'CPF', el('input', { name: 'documento', inputmode: 'numeric', value: m?.documento ?? '' })),
    el('label', { class: 'campo' }, 'Limite da conta (R$)', el('input', { name: 'limite', inputmode: 'decimal', value: m?.limite_proprio ? emReais(m.limite_centavos) : '', placeholder: 'em branco usa o padrão da loja' }))),
  el('label', { class: 'campo' }, 'Observação', el('input', { name: 'observacao', value: m?.observacao ?? '' })),
  el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'fiado_liberado', checked: m === null || m.fiado_liberado ? true : null }), 'Pode comprar na conta (fiado)'),
  m ? el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'ativo', checked: m.ativo ? true : null }), 'Morador ativo') : null,
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Salvar'))));

  const receber = (m) => modal(`Receber de ${m.nome}`, (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.post(`/moradores/${m.id}/receber`, lerForm(e.target));
        toast('Pagamento registrado.');
        fechar();
        recarregar();
      });
    },
  },
  el('p', { class: 'mudo' }, `Saldo atual: ${dinheiro(m.saldo_centavos)}. O valor recebido abate o saldo e quita as faturas mais antigas.`),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Valor (R$)', el('input', { name: 'valor', inputmode: 'decimal', required: true, value: emReais(Math.max(0, m.saldo_centavos)), autofocus: true })),
    el('label', { class: 'campo' }, 'Forma', el('select', { name: 'forma' }, opcoes([{ id: 'dinheiro', nome: 'Dinheiro' }, { id: 'pix', nome: 'PIX' }, { id: 'debito', nome: 'Cartão de débito' }, { id: 'credito', nome: 'Cartão de crédito' }])))),
  el('label', { class: 'campo' }, 'Observação', el('input', { name: 'observacao' })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Registrar'))));

  const ajuste = (m) => modal(`Ajuste na conta de ${m.nome}`, (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.post(`/moradores/${m.id}/ajuste`, lerForm(e.target));
        toast('Ajuste lançado.');
        fechar();
        recarregar();
      });
    },
  },
  el('p', { class: 'mudo' }, 'Use para corrigir um lançamento errado ou conceder um crédito. O ajuste fica registrado com o motivo.'),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Tipo', el('select', { name: 'sinal' }, opcoes([{ id: 'debito', nome: 'Débito (aumenta a dívida)' }, { id: 'credito', nome: 'Crédito (abate)' }]))),
    el('label', { class: 'campo' }, 'Valor (R$)', el('input', { name: 'valor', inputmode: 'decimal', required: true, autofocus: true }))),
  el('label', { class: 'campo' }, 'Motivo', el('input', { name: 'motivo', required: true })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Lançar'))));

  /** Senha numérica que o morador digita no terminal do balcão para comprar na conta. */
  const senhaTerminal = (m) => modal(`Senha do terminal — ${m.nome}`, (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      if (d.pin !== d.repetir) return toast('As duas senhas estão diferentes.', 'erro');
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.post(`/moradores/${m.id}/pin`, { pin: d.pin });
        toast('Senha do terminal definida. Passe o número ao morador.');
        fechar();
        recarregar();
      });
    },
  },
  el('p', { class: 'mudo' }, 'Com esta senha o morador identifica a conta dele no terminal e lança a compra na fatura do mês. '
    + 'São de 4 a 8 números — evite datas óbvias e números repetidos.'),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Senha', el('input', { name: 'pin', inputmode: 'numeric', pattern: '[0-9]{4,8}', maxlength: 8, required: true, autofocus: true, placeholder: '0000' })),
    el('label', { class: 'campo' }, 'Repita a senha', el('input', { name: 'repetir', inputmode: 'numeric', pattern: '[0-9]{4,8}', maxlength: 8, required: true }))),
  el('div', { class: 'linha entre' },
    m.tem_pin ? el('button', { type: 'button', class: 'btn perigo pequeno', onclick: async () => {
      await api.post(`/moradores/${m.id}/pin`, { pin: null });
      toast('Senha removida.');
      fechar();
      recarregar();
    } }, 'Remover senha') : el('span', {}),
    el('div', { class: 'linha' },
      el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
      el('button', { type: 'submit', class: 'btn primario' }, 'Salvar senha')))));

  const acesso = (m) => modal(`Acesso ao portal — ${m.nome}`, (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.post(`/moradores/${m.id}/acesso`, lerForm(e.target));
        toast('Acesso criado. Passe o e-mail e a senha ao morador.');
        fechar();
      });
    },
  },
  el('p', { class: 'mudo' }, 'Com o acesso, o morador acompanha pelo celular o que consumiu no mês e o que já está faturado.'),
  el('label', { class: 'campo' }, 'E-mail', el('input', { name: 'email', type: 'email', required: true, value: m.acesso?.email ?? m.email ?? '', autofocus: true })),
  el('label', { class: 'campo' }, 'Senha', el('input', { name: 'senha', type: 'text', minlength: 8, required: true, placeholder: 'mínimo de 8 caracteres' })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Salvar acesso'))));

  const fecharMes = () => modal('Fechar o mês dos moradores', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        const r = await api.post('/moradores/faturas/fechar', lerForm(e.target));
        toast(r.faturas ? `${r.faturas} fatura(s) geradas · ${dinheiro(r.valor_centavos)}` : 'Nenhuma compra nova para faturar.');
        fechar();
        recarregar();
      });
    },
  },
  el('p', { class: 'mudo' }, 'Gera uma fatura por morador com as compras na conta do período e abre a cobrança no financeiro. Rodar de novo não duplica nada.'),
  el('label', { class: 'campo' }, 'Competência', el('input', { name: 'competencia', type: 'month', value: competenciaAtual(), required: true })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Fechar e gerar faturas'))));

  await desenhar();
}
