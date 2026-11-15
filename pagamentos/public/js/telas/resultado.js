import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, kpi, campo, lerForm, acao, dinheiro, numero, percentual, aviso, icone, modal, confirmar, toast, hojeIso,
} from '../../comum/ui.js';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const nomeMes = (m) => { const [a, n] = m.split('-'); return `${MESES[Number(n) - 1]}/${a}`; };
const reais = (c) => ((c ?? 0) / 100).toFixed(2).replace('.', ',');
const sinal = (c) => (c < 0 ? 'negativo' : c > 0 ? 'positivo' : '');

/** Resultado da PAY AX: receita, impostos, custos do banco, despesas da operação e o lucro do mês. */
export default async function resultado({ alvo, query, recarregar }) {
  const mes = query.mes ?? hojeIso().slice(0, 7);
  const d = await api.get(`/resultado${qs({ mes })}`);
  const editar = pode('despesas.editar');

  const filtro = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/resultado${qs(lerForm(filtro))}`); } },
    campo({ nome: 'mes', rotulo: 'Mês', tipo: 'month', valor: mes }),
    el('button', { class: 'botao', type: 'submit' }, 'Ver mês'),
    el('button', { class: 'botao sec', type: 'button', onclick: () => window.print() }, icone('imprimir'), 'Imprimir'));

  const linha = (rotulo, valor, classe = '', tom = '') => el('div', { class: `linha ${classe}`.trim() },
    el('span', {}, rotulo), el('span', { class: tom }, valor));
  const menos = (c) => (c ? `− ${dinheiro(c)}` : dinheiro(0));

  const cb = d.custo_banco;
  const demonstrativo = el('div', { class: 'dre' },
    linha('Tarifa PAY AX (percentual)', dinheiro(d.receita.tarifa_payax), 'sub'),
    linha('Tarifa de emissão', dinheiro(d.receita.tarifa_emissao), 'sub'),
    linha('Tarifa bancária cobrada dos clientes', dinheiro(d.receita.tarifa_banco), 'sub'),
    linha('Tarifa de repasse', dinheiro(d.receita.tarifa_repasse), 'sub'),
    linha('Receita bruta', dinheiro(d.receita.total), 'total'),
    linha(`Impostos sobre a receita (${percentual(d.impostos.ppm)})`, menos(d.impostos.valor)),
    linha(`Registro de boletos no banco (${numero(cb.registro.quantidade)})`, menos(cb.registro.valor), 'sub'),
    linha(`Liquidação e rateio (${numero(cb.liquidacao.quantidade)})`, menos(cb.liquidacao.valor), 'sub'),
    linha(`PIX de repasse (${numero(cb.pix.quantidade)})`, menos(cb.pix.valor), 'sub'),
    linha('Custos do banco', menos(cb.total), 'total'),
    linha('Margem de contribuição', dinheiro(d.margem_contribuicao), 'total', sinal(d.margem_contribuicao)),
    ...d.despesas.por_categoria.map((c) => linha(c.rotulo, menos(c.valor_centavos), 'sub')),
    linha('Despesas da operação', menos(d.despesas.total), 'total'),
    linha(d.lucro < 0 ? 'Prejuízo do mês' : 'Lucro do mês', dinheiro(d.lucro), 'final', sinal(d.lucro)));

  const eq = d.equilibrio;
  const equilibrio = el('div', { class: 'pares cols-2' },
    par('Boletos pagos no mês', numero(eq.boletos_liquidados)),
    par('Margem média por boleto', eq.margem_por_boleto === null ? '—' : dinheiro(eq.margem_por_boleto)),
    par('Boletos pagos para cobrir as despesas', eq.boletos_necessarios === null ? '—' : numero(eq.boletos_necessarios)),
    par('Situação', eq.boletos_necessarios === null ? '—'
      : eq.boletos_liquidados >= eq.boletos_necessarios ? 'Acima do ponto de equilíbrio'
        : `Faltam ${numero(eq.boletos_necessarios - eq.boletos_liquidados)} boleto(s) pagos`));

  const imposto = editar ? el('form', { class: 'linha-form', style: 'margin-top:14px', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'percentual', rotulo: 'Alíquota sobre a receita (%)', valor: String((d.impostos.ppm / 10000)).replace('.', ','),
      ajuda: 'A efetiva do Simples Nacional (ou do regime da empresa), informada pela contabilidade.' }),
    el('div', { class: 'campo-form' }, el('span', {}, ' '), el('button', { class: 'botao sec', type: 'button', style: 'justify-self:start', onclick: (e) => acao(e.currentTarget, async () => {
      await api.put('/resultado/imposto', lerForm(e.currentTarget.form));
      toast('Alíquota salva.', 'ok'); recarregar();
    }) }, 'Salvar alíquota'))) : null;

  const vigencia = (x) => (x.recorrencia === 'unica' ? `Só em ${nomeMes(x.inicio)}`
    : x.fim ? `De ${nomeMes(x.inicio)} a ${nomeMes(x.fim)}` : `Todo mês desde ${nomeMes(x.inicio)}`);

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Resultado'),
        el('p', {}, `Lucro real da PAY AX em ${nomeMes(mes)}: o que cobramos dos clientes, menos impostos, banco e despesas da operação.`)),
      editar ? el('div', { class: 'acoes' }, el('button', { class: 'botao', onclick: () => formDespesa({ categorias: d.categorias, mes, recarregar }) },
        icone('mais'), 'Nova despesa')) : null),
    filtro,
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Receita bruta', valor: dinheiro(d.receita.total), apoio: 'tarifas cobradas dos clientes', tom: 'destaque', ic: 'dinheiro' }),
      kpi({ rotulo: 'Banco e impostos', valor: dinheiro(d.custo_banco.total + d.impostos.valor), apoio: `banco ${dinheiro(d.custo_banco.total)} · impostos ${dinheiro(d.impostos.valor)}`, ic: 'banco' }),
      kpi({ rotulo: 'Despesas da operação', valor: dinheiro(d.despesas.total), apoio: `${d.despesas.por_categoria.length} categoria(s)`, ic: 'relatorio' }),
      kpi({ rotulo: d.lucro < 0 ? 'Prejuízo do mês' : 'Lucro do mês', valor: dinheiro(d.lucro),
        apoio: d.margem_lucro_ppm === null ? 'sem receita no mês' : `${numero(d.margem_lucro_ppm / 10000, 1)}% da receita`, tom: d.lucro < 0 ? 'negativo' : 'positivo', ic: 'grafico' })),

    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao(`Demonstrativo de ${nomeMes(mes)}`, demonstrativo),
      cartao('Ponto de equilíbrio', [equilibrio,
        el('p', { class: 'regra-exige', style: 'margin-top:12px' },
          'Custos do banco calculados pelas tarifas cadastradas em Contas e preços (registro, liquidação, rateio e PIX), congeladas em cada operação. No fechamento, confira com o extrato do Bradesco.'),
        imposto])),

    el('div', { style: 'margin-top:14px' }, cartao('Últimos 6 meses', tabela({
      colunas: [
        { titulo: 'Mês', conteudo: (h) => el('strong', {}, nomeMes(h.mes)) },
        { titulo: 'Receita', dir: true, conteudo: (h) => dinheiro(h.receita) },
        { titulo: 'Banco e impostos', dir: true, conteudo: (h) => dinheiro(h.custos) },
        { titulo: 'Despesas', dir: true, conteudo: (h) => dinheiro(h.despesas) },
        { titulo: 'Lucro', dir: true, conteudo: (h) => el('strong', { style: h.lucro < 0 ? 'color:var(--vermelho)' : null }, dinheiro(h.lucro)) },
      ],
      itens: d.historico,
      aoClicar: (h) => ir(`#/resultado${qs({ mes: h.mes })}`),
    }))),

    el('div', { style: 'margin-top:14px' }, cartao('Despesas da operação', tabela({
      colunas: [
        { titulo: 'Despesa', conteudo: (x) => el('span', {}, el('span', { class: 'forte' }, x.descricao), el('span', { class: 'sub' }, d.categorias[x.categoria])) },
        { titulo: 'Valor', dir: true, conteudo: (x) => el('strong', {}, dinheiro(x.valor_centavos)) },
        { titulo: 'Quando', conteudo: (x) => vigencia(x) },
        { titulo: 'Observação', conteudo: (x) => x.observacao ?? '—' },
        ...(editar ? [{ titulo: '', dir: true, conteudo: (x) => el('span', { style: 'display:inline-flex;gap:6px' },
          el('button', { class: 'botao sec pequeno', onclick: () => formDespesa({ categorias: d.categorias, mes, recarregar, atual: x }) }, 'Editar'),
          el('button', { class: 'botao sec pequeno', onclick: (e) => acao(e.currentTarget, () => removerOuEncerrar(x, mes, recarregar)) },
            x.recorrencia === 'mensal' && !x.fim ? 'Encerrar' : 'Excluir')) }] : []),
      ],
      itens: d.despesas_cadastradas,
      vazio: 'Nenhuma despesa cadastrada. Cadastre servidor, equipe, contador, sistemas: o lucro do mês só é real com elas.',
    }))),
  );
}

function par(rot, val) {
  return el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));
}

/** Despesa mensal em vigor: encerra no mês escolhido (os meses passados ficam como estavam). Única: exclui. */
async function removerOuEncerrar(x, mes, recarregar) {
  if (x.recorrencia === 'mensal' && !x.fim) {
    const ok = await confirmar({ titulo: 'Encerrar despesa', texto: `"${x.descricao}" deixa de contar depois de ${nomeMes(mes)}. Os meses anteriores não mudam.`, confirmarTexto: 'Encerrar' });
    if (!ok) return;
    await api.put(`/resultado/despesas/${x.id}`, { ...x, valor: reais(x.valor_centavos), fim: mes < x.inicio ? x.inicio : mes });
    toast('Despesa encerrada.', 'ok');
  } else {
    const ok = await confirmar({ titulo: 'Excluir despesa', texto: `Excluir "${x.descricao}"?`, confirmarTexto: 'Excluir', perigo: true });
    if (!ok) return;
    await api.del(`/resultado/despesas/${x.id}`);
    toast('Despesa excluída.', 'ok');
  }
  recarregar();
}

function formDespesa({ categorias, mes, recarregar, atual = null }) {
  const form = el('form', { class: 'form-grade', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'descricao', rotulo: 'Descrição', valor: atual?.descricao ?? '', obrigatorio: true, atributos: { maxlength: 120, placeholder: 'Ex.: Servidor Hostinger KVM 2' } }),
    campo({ nome: 'categoria', rotulo: 'Categoria', tipo: 'select', valor: atual?.categoria ?? 'infraestrutura', opcoes: Object.entries(categorias) }),
    el('div', { class: 'linha-form' },
      campo({ nome: 'valor', rotulo: 'Valor (R$)', tipo: 'dinheiro', valor: atual ? reais(atual.valor_centavos) : '', obrigatorio: true }),
      campo({ nome: 'recorrencia', rotulo: 'Repete', tipo: 'select', valor: atual?.recorrencia ?? 'mensal', opcoes: [['mensal', 'Todo mês'], ['unica', 'Só uma vez']] })),
    el('div', { class: 'linha-form' },
      campo({ nome: 'inicio', rotulo: 'A partir de (ou o mês)', tipo: 'month', valor: atual?.inicio ?? mes, obrigatorio: true }),
      campo({ nome: 'fim', rotulo: 'Até (opcional)', tipo: 'month', valor: atual?.fim ?? '', ajuda: 'Só para despesa mensal.' })),
    campo({ nome: 'observacao', rotulo: 'Observação', valor: atual?.observacao ?? '', atributos: { maxlength: 300 } }));
  const salvar = el('button', { class: 'botao', type: 'button' }, atual ? 'Salvar' : 'Cadastrar');
  const m = modal({ titulo: atual ? 'Editar despesa' : 'Nova despesa', corpo: form, acoes: [
    el('button', { class: 'botao sec', type: 'button', onclick: () => m.fechar() }, 'Cancelar'), salvar] });
  salvar.addEventListener('click', () => acao(salvar, async () => {
    if (!form.reportValidity()) return;
    const dados = lerForm(form);
    if (atual) await api.put(`/resultado/despesas/${atual.id}`, { ...dados, versao: atual.versao });
    else await api.post('/resultado/despesas', dados);
    m.fechar(); toast(atual ? 'Despesa alterada.' : 'Despesa cadastrada.', 'ok'); recarregar();
  }));
}
