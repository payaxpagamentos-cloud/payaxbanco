import { api } from '../api.js';
import { el, limpar, dinheiro, qtd, dataBr, dataHora, indicador, tabela, modal, etiqueta, mesPorExtenso } from '../ui.js';

/** Portal do morador: o que ele consumiu no mês, o extrato da conta e as faturas. */
export default async function minhaConta({ alvo, definirTitulo }) {
  const d = await api.get('/moradores/minha-conta');
  const m = d.morador;
  definirTitulo('Minha conta', `${m.nome} · ${m.bloco}/${m.unidade}`);

  limpar(alvo,
    el('div', { class: 'grade' },
      indicador({ rotulo: 'Saldo em aberto', valor: dinheiro(m.saldo_centavos), tom: m.saldo_centavos > 0 ? 'vermelho' : 'verde', nota: m.saldo_centavos > 0 ? 'a acertar com o mercadinho' : 'tudo em dia' }),
      indicador({ rotulo: 'Consumo deste mês', valor: dinheiro(d.consumo_do_mes.total_centavos), nota: `${d.consumo_do_mes.compras} compra(s)` }),
      indicador({ rotulo: 'Limite', valor: dinheiro(m.limite_centavos), nota: `disponível ${dinheiro(m.disponivel_centavos)}` })),

    el('section', { class: 'cartao' },
      el('h2', {}, 'Minhas compras'),
      tabela([
        { titulo: 'Quando', celula: (v) => dataHora(v.fechada_em) },
        { titulo: 'Compra', celula: (v) => `#${v.id}` },
        { titulo: 'Valor', direita: true, celula: (v) => el('strong', {}, dinheiro(v.total_centavos)) },
      ], d.compras, { aoClicar: (v) => detalhe(v.id), vazio: 'Você ainda não comprou no mercadinho.' })),

    el('section', { class: 'cartao' },
      el('h2', {}, 'Faturas'),
      tabela([
        { titulo: 'Mês', celula: (f) => mesPorExtenso(f.competencia) },
        { titulo: 'Vencimento', celula: (f) => dataBr(f.vencimento) },
        { titulo: 'Compras', direita: true, celula: (f) => f.compras },
        { titulo: 'Valor', direita: true, celula: (f) => dinheiro(f.valor_centavos) },
        { titulo: 'Situação', direita: true, celula: (f) => etiqueta(f.status, f.status === 'paga' ? 'ok' : 'aviso') },
      ], d.faturas, { vazio: 'Nenhuma fatura fechada ainda.' })),

    el('section', { class: 'cartao' },
      el('h2', {}, 'Extrato da conta'),
      tabela([
        { titulo: 'Quando', celula: (l) => dataHora(l.criado_em) },
        { titulo: 'Lançamento', celula: (l) => l.descricao },
        { titulo: 'Valor', direita: true, celula: (l) => el('span', { class: l.valor_centavos > 0 ? 'negativo' : 'positivo' }, dinheiro(l.valor_centavos)) },
      ], d.extrato, { vazio: 'Sem lançamentos.' })));

  async function detalhe(id) {
    const v = await api.get(`/moradores/minha-conta/compras/${id}`);
    await modal(`Compra #${v.id}`, (fechar) => [
      el('p', { class: 'mudo' }, dataHora(v.fechada_em)),
      tabela([
        { titulo: 'Item', celula: (i) => i.descricao },
        { titulo: 'Qtd.', direita: true, celula: (i) => qtd(i.qtd_mil, i.unidade) },
        { titulo: 'Valor', direita: true, celula: (i) => dinheiro(i.total_centavos) },
      ], v.itens),
      el('div', { class: 'linha entre', style: 'margin-top: 12px' }, el('strong', {}, 'Total'), el('strong', {}, dinheiro(v.total_centavos))),
      el('div', { class: 'linha fim' }, el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Fechar')),
    ]);
  }
}
