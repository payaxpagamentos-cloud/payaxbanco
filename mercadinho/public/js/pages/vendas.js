import { api } from '../api.js';
import { el, $, limpar, dinheiro, qtd, dataHora, dataBr, icone, indicador, tabela, modal, toast, acao, etiqueta, confirmar, hojeLocal, somarDias, opcoes, FORMAS } from '../ui.js';

/**
 * Vendas feitas pelos clientes no terminal do balcão: acompanhamento, cupom, cancelamento
 * e a conferência dos PIX (que o próprio cliente confirma na tela).
 */
export default async function vendas({ alvo, usuario, definirTitulo }) {
  const gestao = ['admin', 'gerente'].includes(usuario.perfil);
  let aba = 'vendas';
  let periodo = { de: somarDias(hojeLocal(), -6), ate: hojeLocal() };
  let status = 'paga';

  async function desenhar() {
    definirTitulo('Vendas', `${dataBr(periodo.de)} a ${dataBr(periodo.ate)}`);
    limpar(alvo,
      el('section', { class: 'cartao' },
        el('div', { class: 'linha entre' },
          el('div', { class: 'linha' },
            el('label', { class: 'campo' }, 'De', el('input', { type: 'date', value: periodo.de, onchange: (e) => { periodo.de = e.target.value; recarregar(); } })),
            el('label', { class: 'campo' }, 'Até', el('input', { type: 'date', value: periodo.ate, onchange: (e) => { periodo.ate = e.target.value; recarregar(); } })),
            aba === 'vendas' ? el('label', { class: 'campo' }, 'Situação', el('select', { style: 'width: auto', onchange: (e) => { status = e.target.value; recarregar(); } },
              opcoes([{ id: 'paga', nome: 'Pagas' }, { id: 'cancelada', nome: 'Canceladas' }, { id: 'aberta', nome: 'Em andamento' }, { id: '', nome: 'Todas' }], { selecionado: status }))) : null),
          el('div', { class: 'abas' }, [['vendas', 'Vendas do terminal'], ['pix', 'Conferência de PIX']].map(([chave, rotulo]) =>
            el('button', { class: aba === chave ? 'ativa' : '', onclick: () => { aba = chave; desenhar(); } }, rotulo))))),
      el('div', { id: 'corpo' }));
    recarregar();
  }

  async function recarregar() {
    const corpo = $('#corpo');
    limpar(corpo, el('div', { class: 'carregando' }, el('div', { class: 'girando' })));
    definirTitulo('Vendas', `${dataBr(periodo.de)} a ${dataBr(periodo.ate)}`);

    if (aba === 'pix') {
      const lista = await api.get(`/pdv/conferencia?de=${periodo.de}&ate=${periodo.ate}`);
      const pendentes = lista.filter((p) => !p.conferido_em);
      return limpar(corpo,
        el('div', { class: 'grade' },
          indicador({ simbolo: 'pix', cor: 'azul', rotulo: 'PIX do período', valor: dinheiro(lista.reduce((s, p) => s + p.valor_centavos, 0)), nota: `${lista.length} pagamento(s)` }),
          indicador({ simbolo: 'alerta', cor: pendentes.length ? 'ambar' : '', rotulo: 'A conferir no extrato', valor: dinheiro(pendentes.reduce((s, p) => s + p.valor_centavos, 0)), nota: `${pendentes.length} pendente(s)` })),
        el('section', { class: 'cartao' },
          el('p', { class: 'mudo' }, 'No terminal é o próprio cliente que confirma o PIX. Confira cada um no extrato da conta e marque aqui — o que ficar pendente aparece para a próxima conferência.'),
          tabela([
            { titulo: 'Quando', celula: (p) => dataHora(p.fechada_em) },
            { titulo: 'Compra', celula: (p) => `#${p.venda}` },
            { titulo: 'Terminal', celula: (p) => p.terminal ?? '—' },
            { titulo: 'Valor', direita: true, celula: (p) => el('strong', {}, dinheiro(p.valor_centavos)) },
            { titulo: 'Conferido', celula: (p) => (p.conferido_em ? etiqueta(`${dataBr(p.conferido_em)} · ${p.conferido_por_nome ?? ''}`.trim(), 'ok') : etiqueta('pendente', 'aviso')) },
            { titulo: '', direita: true, celula: (p) => (gestao ? el('button', {
              class: `btn pequeno${p.conferido_em ? '' : ' primario'}`,
              onclick: (e) => { e.stopPropagation(); acao(e.currentTarget, async () => { await api.post(`/pdv/pagamentos/${p.id}/conferir`, {}); recarregar(); }); },
            }, p.conferido_em ? 'Desfazer' : 'Conferi') : null) },
          ], lista, { aoClicar: (p) => ficha(p.venda), vazio: 'Nenhum PIX do terminal no período.' })));
    }

    const lista = await api.get(`/pdv/vendas?de=${periodo.de}&ate=${periodo.ate}${status ? `&status=${status}` : ''}&limite=300`);
    const pagas = lista.filter((v) => v.status === 'paga');
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ simbolo: 'pdv', rotulo: 'Vendas no período', valor: String(pagas.length), nota: `${dinheiro(pagas.reduce((s, v) => s + v.total_centavos, 0))} no total` }),
        indicador({ simbolo: 'financeiro', rotulo: 'Ticket médio', valor: dinheiro(pagas.length ? Math.round(pagas.reduce((s, v) => s + v.total_centavos, 0) / pagas.length) : 0), cor: 'azul' }),
        indicador({ simbolo: 'x', cor: 'vermelho', rotulo: 'Canceladas', valor: String(lista.filter((v) => v.status === 'cancelada').length) })),
      el('section', { class: 'cartao' },
        tabela([
          { titulo: 'Compra', celula: (v) => `#${v.id}` },
          { titulo: 'Quando', celula: (v) => dataHora(v.fechada_em ?? v.criada_em) },
          { titulo: 'Origem', celula: (v) => (v.origem === 'autoatendimento' ? etiqueta(v.terminal ?? 'terminal', 'info') : etiqueta(v.operador ?? 'atendimento')) },
          { titulo: 'Cliente', celula: (v) => (v.morador ? `${v.morador} · ${v.bloco}/${v.unidade}` : '—') },
          { titulo: 'Pagamento', celula: (v) => (v.formas ?? '').split(',').filter(Boolean).map((f) => etiqueta(FORMAS[f] ?? f)) },
          { titulo: 'Total', direita: true, celula: (v) => el('strong', {}, dinheiro(v.total_centavos)) },
          { titulo: 'Situação', direita: true, celula: (v) => etiqueta(v.status, v.status === 'paga' ? 'ok' : v.status === 'cancelada' ? 'erro' : 'aviso') },
        ], lista, { aoClicar: (v) => ficha(v.id), vazio: 'Nenhuma venda nesse período.' })));
  }

  async function ficha(id) {
    const v = await api.get(`/pdv/vendas/${id}`);
    await modal(`Compra #${v.id}`, (fechar) => [
      el('div', { class: 'linha entre' },
        el('div', {}, el('div', { class: 'mudo pequeno' }, dataHora(v.fechada_em ?? v.criada_em)),
          el('div', { class: 'total' }, dinheiro(v.total_centavos))),
        etiqueta(v.status, v.status === 'paga' ? 'ok' : v.status === 'cancelada' ? 'erro' : 'aviso')),
      el('p', { class: 'mudo pequeno' }, [v.origem === 'autoatendimento' ? `Terminal ${v.terminal ?? ''}`.trim() : `Operador ${v.operador ?? '—'}`,
        v.morador ? `${v.morador} (${v.bloco}/${v.unidade})` : null, v.motivo_cancelamento].filter(Boolean).join(' · ')),
      tabela([
        { titulo: 'Item', celula: (i) => i.descricao },
        { titulo: 'Qtd.', direita: true, celula: (i) => qtd(i.qtd_mil, i.unidade) },
        { titulo: 'Preço', direita: true, celula: (i) => dinheiro(i.preco_centavos) },
        { titulo: 'Total', direita: true, celula: (i) => dinheiro(i.total_centavos) },
      ], v.itens),
      v.pagamentos.length ? el('div', {}, el('h3', {}, 'Pagamento'), tabela([
        { titulo: 'Forma', celula: (p) => FORMAS[p.forma] ?? p.forma },
        { titulo: 'Detalhe', celula: (p) => (p.nsu ? `${p.bandeira ?? 'cartão'} · NSU ${p.nsu}` : p.forma === 'pix' ? (p.conferido_em ? 'conferido no extrato' : 'confirmado pelo cliente') : '—') },
        { titulo: 'Valor', direita: true, celula: (p) => dinheiro(p.valor_centavos) },
      ], v.pagamentos)) : null,
      el('div', { class: 'linha fim' },
        el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Fechar'),
        gestao && v.status !== 'cancelada' ? el('button', { class: 'btn perigo', onclick: async () => {
          if (!await confirmar('Cancelar a compra?', 'Os itens voltam para o estoque, o fiado é estornado e a cobrança no cartão é cancelada.', 'Cancelar compra', true)) return;
          await api.post(`/pdv/vendas/${v.id}/cancelar`, { motivo: 'Cancelada pela gestão' });
          toast('Compra cancelada.');
          fechar();
          recarregar();
        } }, icone('x'), 'Cancelar compra') : null),
    ], { largo: true });
  }

  await desenhar();
}
