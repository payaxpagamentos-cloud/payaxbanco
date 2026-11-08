import { api } from '../api.js';
import { html, $, $$, moeda, numero, data, status, opcoes, paginacao, debounce, modal, dadosForm, toast, hoje, inicioMes, fimMes, somarMeses, somarDias } from '../ui.js';
import { cadastrosDaEmpresa, novoLancamento, detalheLancamento, baixar, recarregar, APROVACAO, importarNfe } from './comum.js';

const SITUACOES = [['a_vencer', 'A vencer'], ['vencido', 'Vencidos'], ['aberto', 'Em aberto (todos)'], ['pago', 'Baixados'], ['cancelado', 'Cancelados'], ['todos', 'Todos']];

/** Contas a pagar ou a receber da empresa em atendimento. */
export default async function lancamentos({ alvo, ativo, base, tipo, empresa }) {
  const empresaId = empresa.id;
  const cad = await cadastrosDaEmpresa(base);
  if (!ativo()) return;
  const dia = hoje();
  const filtros = { tipo, status: 'aberto', de: '', ate: '', data_por: 'vencimento', categoria_id: '', contato_id: '', busca: '', pagina: 1, limite: 50 };
  const pagar = tipo === 'pagar';
  const verbo = pagar ? 'Pagar' : 'Receber';
  const cats = cad.categorias.filter((c) => c.tipo === (pagar ? 'despesa' : 'receita'));
  const contatos = cad.contatos.filter((c) => c.tipo === 'ambos' || c.tipo === (pagar ? 'fornecedor' : 'cliente'));
  const periodos = [
    ['', 'Qualquer data'], ['hoje', 'Hoje'], ['7', 'Próximos 7 dias'], ['mes', 'Este mês'], ['prox', 'Próximo mês'], ['ant', 'Mês anterior'],
  ];
  const aplicarPeriodo = (p) => {
    const intervalos = {
      '': ['', ''], hoje: [dia, dia], 7: [dia, somarDias(dia, 7)], mes: [inicioMes(dia), fimMes(dia)],
      prox: [somarMeses(dia, 1), fimMes(somarMeses(dia, 1))], ant: [somarMeses(dia, -1), fimMes(somarMeses(dia, -1))],
    };
    [filtros.de, filtros.ate] = intervalos[p];
  };
  const selecionados = new Set();

  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Contas a ${pagar ? 'pagar' : 'receber'}</h1>
      <p class="muted">${pagar ? 'Fornecedores, impostos, folha e demais saídas.' : 'Vendas, serviços e demais entradas.'}</p></div>
      <div class="row"><button class="btn" id="nfe">Importar NF-e (XML)</button><button class="btn" id="csv">Exportar CSV</button><button class="btn primario" id="novo">+ Nova conta a ${pagar ? 'pagar' : 'receber'}</button></div></div>
    <div class="grid grid-4" id="totais"></div>
    <div class="card" style="margin-top:16px">
      <div class="filtros">
        <input class="busca" id="busca" placeholder="Descrição, documento ou ${pagar ? 'fornecedor' : 'cliente'}">
        <select class="campo" data-f="status">${SITUACOES.map(([v, r]) => html`<option value="${v}" ${v === 'aberto' ? 'selected' : ''}>${r}</option>`)}</select>
        <select class="campo" id="periodo">${periodos.map(([v, r]) => html`<option value="${v}">${r}</option>`)}</select>
        <select class="campo" data-f="data_por"><option value="vencimento">por vencimento</option><option value="competencia">por competência</option><option value="pagamento">por data da baixa</option></select>
        <select class="campo" data-f="categoria_id">${opcoes(cats, { vazio: 'Todas as categorias' })}</select>
        <select class="campo" data-f="contato_id">${opcoes(contatos, { vazio: pagar ? 'Todos os fornecedores' : 'Todos os clientes' })}</select>
      </div>
      <div class="table-wrap" id="tabela"></div><div id="pag"></div>
    </div>
    <div class="selecao-lote hidden" id="lote"><span id="lote-info"></span><div class="row"><button class="btn sm" id="lote-limpar">Limpar</button><button class="btn sm ouro" id="lote-baixar">${verbo} selecionados</button></div></div>`);

  const atualizarLote = (itens) => {
    const marcados = itens.filter((l) => selecionados.has(l.id));
    $('#lote', alvo).classList.toggle('hidden', !selecionados.size);
    $('#lote-info', alvo).textContent = `${selecionados.size} selecionado(s) · ${moeda(marcados.reduce((a, l) => a + l.valor_centavos, 0))}`;
  };

  let itensAtuais = [];
  const carregar = async () => {
    const r = await api.get(`${base}/lancamentos`, filtros);
    if (!ativo()) return;
    itensAtuais = r.itens;
    const t = r.totais;
    $('#totais', alvo).innerHTML = String(html`
      <div class="card kpi azul"><div class="rotulo">Lançamentos no filtro</div><div class="valor">${numero(t.quantidade)}</div><div class="sub">Total ${moeda(t.valor_centavos)}</div></div>
      <div class="card kpi"><div class="rotulo">Em aberto</div><div class="valor">${moeda(t.aberto_centavos)}</div><div class="sub">A ${pagar ? 'pagar' : 'receber'}</div></div>
      <div class="card kpi vermelho"><div class="rotulo">Vencido</div><div class="valor">${moeda(t.vencido_centavos)}</div><div class="sub">Em aberto e com vencimento passado</div></div>
      <div class="card kpi verde"><div class="rotulo">${pagar ? 'Pago' : 'Recebido'}</div><div class="valor">${moeda(t.pago_centavos)}</div><div class="sub">Com juros e descontos</div></div>`);
    $('#tabela', alvo).innerHTML = String(html`<table><thead><tr><th class="sel"><input type="checkbox" id="todos" aria-label="Selecionar todos em aberto"></th>
      <th>Vencimento</th><th>Descrição</th><th>${pagar ? 'Fornecedor' : 'Cliente'}</th><th>Categoria</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
      ${r.itens.length ? r.itens.map((l) => html`<tr class="clicavel" data-id="${l.id}">
        <td class="sel">${l.status === 'aberto' && ['dispensada', 'aprovada'].includes(l.aprovacao) ? html`<input type="checkbox" data-sel="${l.id}" ${selecionados.has(l.id) ? 'checked' : ''} aria-label="Selecionar">` : ''}</td>
        <td style="white-space:nowrap">${data(l.vencimento)}${l.status === 'pago' ? html`<div class="small muted">baixa ${data(l.pago_em)}</div>` : ''}</td>
        <td><strong>${l.descricao}</strong>${l.total_parcelas > 1 ? html` <span class="badge">${l.recorrente ? 'Mensal ' : ''}${l.parcela}/${l.total_parcelas}</span>` : ''}
          <div class="small muted">${[l.documento && `Doc. ${l.documento}`, l.documentos && `${l.documentos} anexo(s)`, l.rateado && 'rateado'].filter(Boolean).join(' · ')}</div></td>
        <td>${l.contato_nome ?? html`<span class="muted">—</span>`}</td>
        <td class="small">${l.categoria_nome}${l.centro_nome ? html`<div class="muted">${l.centro_nome}</div>` : ''}</td>
        <td class="num"><strong>${moeda(l.valor_centavos)}</strong>${l.status === 'pago' && l.valor_pago_centavos !== l.valor_centavos ? html`<div class="small muted">${pagar ? 'pago' : 'recebido'} ${moeda(l.valor_pago_centavos)}</div>` : ''}</td>
        <td>${status(l.situacao)} ${l.status === 'aberto' ? APROVACAO[l.aprovacao] ?? '' : ''}</td>
        <td class="right">${l.status === 'aberto' ? (['dispensada', 'aprovada'].includes(l.aprovacao) ? html`<button class="btn sm" data-baixar="${l.id}">${verbo}</button>`
          : html`<a class="btn sm" href="#/e/${empresaId}/aprovacoes">Aprovação</a>`) : ''}</td></tr>`)
        : html`<tr><td colspan="8" class="vazio">Nenhum lançamento com esses filtros.</td></tr>`}</tbody></table>`);
    $('#pag', alvo).replaceChildren(paginacao(r, (p) => { filtros.pagina = p; carregar(); }));
    $$('tr[data-id]', alvo).forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('button, input')) return;
      detalheLancamento(base, tr.dataset.id).catch((err) => toast(err.message, 'erro'));
    }));
    $$('[data-baixar]', alvo).forEach((b) => b.addEventListener('click', () => baixar(base, r.itens.find((l) => l.id === Number(b.dataset.baixar)), cad.contas)));
    $$('[data-sel]', alvo).forEach((c) => c.addEventListener('change', () => { c.checked ? selecionados.add(Number(c.dataset.sel)) : selecionados.delete(Number(c.dataset.sel)); atualizarLote(itensAtuais); }));
    $('#todos', alvo).addEventListener('change', (e) => {
      $$('[data-sel]', alvo).forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); });
    });
    atualizarLote(itensAtuais);
  };

  $('#busca', alvo).addEventListener('input', debounce((e) => { filtros.busca = e.target.value; filtros.pagina = 1; carregar(); }));
  $$('[data-f]', alvo).forEach((s) => s.addEventListener('change', () => { filtros[s.dataset.f] = s.value; filtros.pagina = 1; carregar(); }));
  $('#periodo', alvo).addEventListener('change', (e) => { aplicarPeriodo(e.target.value); filtros.pagina = 1; carregar(); });
  $('#novo', alvo).addEventListener('click', () => novoLancamento(base, tipo));
  $('#nfe', alvo).addEventListener('click', () => importarNfe(base).catch((err) => toast(err.message, 'erro')));
  $('#csv', alvo).addEventListener('click', () => api.baixar(`${base}/lancamentos.csv`, filtros).catch((err) => toast(err.message, 'erro')));
  $('#lote-limpar', alvo).addEventListener('click', () => { selecionados.clear(); carregar(); });
  $('#lote-baixar', alvo).addEventListener('click', () => modal({
    titulo: `${verbo} ${selecionados.size} lançamento(s)`,
    corpo: html`<p style="margin-top:0">Todos recebem a mesma data e conta, pelo valor original (sem juros nem desconto).</p><div class="form">
      <div class="c6"><label>Data</label><input name="data" type="date" required value="${dia}"></div>
      <div class="c6"><label>Conta</label><select name="conta_bancaria_id" required>${opcoes(cad.contas, { rotulo: 'descricao', vazio: 'Selecione' })}</select></div></div>`,
    rotuloEnviar: 'Confirmar baixas',
    aoEnviar: async (form, fechar) => {
      const r = await api.post(`${base}/lancamentos/baixa-lote`, { ...dadosForm(form), ids: [...selecionados] });
      fechar();
      selecionados.clear();
      toast(`${r.baixados} baixa(s) registrada(s).`);
      recarregar();
    },
  }));
  await carregar();
}
