import { api } from '../api.js';
import { pode, definirTitulo } from '../contexto.js';
import { html, $, $$, moeda, data, pct, status, modal, toast, dadosForm, centavos, debounce } from '../ui.js';
import { seletor, ligarSeletor } from './seletores.js';

const hoje = () => new Date().toISOString().slice(0, 10);

function cronograma(linhas) {
  return html`<div class="table-wrap" style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:8px"><table>
    <thead><tr><th>Nº</th><th>Vencimento</th><th class="num">Parcela</th><th class="num">Juros</th><th class="num">Amortização</th><th class="num">Saldo devedor</th></tr></thead>
    <tbody>${linhas.map((p) => html`<tr><td>${p.numero}</td><td>${data(p.vencimento)}</td><td class="num">${moeda(p.valor_centavos)}</td>
      <td class="num">${moeda(p.juros_centavos)}</td><td class="num">${moeda(p.amortizacao_centavos)}</td><td class="num">${moeda(p.saldo_devedor_centavos)}</td></tr>`)}</tbody></table></div>`;
}

function novoEmprestimo(aoSalvar) {
  modal({
    titulo: 'Contratar empréstimo',
    grande: true,
    rotuloEnviar: 'Contratar e creditar',
    corpo: html`<div class="form">
      <div class="c12">${seletor('conta', 'Conta de crédito (corrente, pagamento ou salário)', 'Buscar conta por número ou titular')}</div>
      <div class="c4"><label>Valor (R$)</label><input name="valor" class="moeda" inputmode="numeric" value="0,00"></div>
      <div class="c4"><label>Taxa de juros ao mês (%)</label><input name="taxa" inputmode="decimal" value="1,99"></div>
      <div class="c4"><label>Parcelas</label><input name="parcelas" type="number" min="1" max="120" value="12"></div>
      <div class="c12" id="simulacao"><div class="ajuda">Preencha valor, taxa e parcelas para simular (Tabela Price).</div></div>
    </div>`,
    aoAbrir: (el) => {
      ligarSeletor(el, 'conta', 'conta');
      const simular = debounce(async () => {
        const f = $('form', el);
        const corpo = { valor_centavos: centavos(f.valor.value), taxa_mensal: Number(f.taxa.value.replace(',', '.')) / 100, num_parcelas: Number(f.parcelas.value) };
        if (corpo.valor_centavos <= 0) return;
        try {
          const s = await api.post('/emprestimos/simular', corpo);
          $('#simulacao', el).innerHTML = String(html`<div class="grid grid-3" style="margin-bottom:12px">
            <div class="card kpi"><div class="rotulo">Parcela</div><div class="valor">${moeda(s.valor_parcela_centavos)}</div></div>
            <div class="card kpi azul"><div class="rotulo">Total a pagar</div><div class="valor">${moeda(s.total_centavos)}</div></div>
            <div class="card kpi vermelho"><div class="rotulo">Juros totais</div><div class="valor">${moeda(s.juros_total_centavos)}</div></div></div>${cronograma(s.cronograma)}`);
        } catch (e) {
          $('#simulacao', el).innerHTML = String(html`<div class="ajuda neg">${e.message}</div>`);
        }
      }, 350);
      $$('[name=valor], [name=taxa], [name=parcelas]', el).forEach((i) => i.addEventListener('input', simular));
    },
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      if (!d.conta) throw new Error('Selecione a conta de crédito.');
      const e = await api.post('/emprestimos', {
        conta_id: Number(d.conta), valor_centavos: centavos(d.valor),
        taxa_mensal: Number(String(d.taxa).replace(',', '.')) / 100, num_parcelas: Number(d.parcelas),
      });
      fechar();
      toast(`Empréstimo #${e.id} contratado e creditado.`);
      aoSalvar?.(e);
    },
  });
}

export async function listaEmprestimos({ alvo, ativo }) {
  const filtro = { q: '', status: '' };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Empréstimos</h1><p class="muted">Carteira de crédito pessoal e empresarial (Tabela Price).</p></div>
      ${pode('emprestimos.conceder') ? html`<button class="btn primario" id="novo">+ Contratar empréstimo</button>` : ''}</div>
    <div class="card"><div class="filtros"><div class="busca"><input type="search" id="q" placeholder="Buscar por cliente"></div>
      <div class="campo"><select id="st"><option value="">Todos</option><option value="ativo">Ativos</option><option value="quitado">Quitados</option></select></div></div>
      <div id="tabela"></div></div>`);
  async function carregar() {
    const itens = await api.get('/emprestimos', filtro);
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Cliente</th><th>Conta</th><th class="num">Valor</th><th class="num">Taxa a.m.</th><th class="num">Parcelas</th><th class="num">Saldo devedor</th><th>Próx. vencimento</th><th>Status</th></tr></thead><tbody>
      ${itens.length ? itens.map((e) => html`<tr class="clicavel" data-id="${e.id}"><td>#${e.id}</td><td>${e.cliente_nome}</td><td class="mono">${e.conta}</td>
        <td class="num">${moeda(e.valor_centavos)}</td><td class="num">${pct(e.taxa_mensal)}</td><td class="num">${e.parcelas_pagas}/${e.num_parcelas}</td>
        <td class="num">${moeda(e.saldo_devedor_centavos)}</td>
        <td>${e.proximo_vencimento ? html`${data(e.proximo_vencimento)} ${e.proximo_vencimento < hoje() ? html`<span class="badge danger">vencida</span>` : ''}` : '—'}</td><td>${status(e.status)}</td></tr>`)
        : html`<tr><td colspan="9" class="vazio">Nenhum empréstimo.</td></tr>`}</tbody></table></div>`);
    $$('tr[data-id]', alvo).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/emprestimos/${tr.dataset.id}`; }));
  }
  $('#q', alvo).addEventListener('input', debounce((e) => { filtro.q = e.target.value; carregar(); }));
  $('#st', alvo).addEventListener('change', (e) => { filtro.status = e.target.value; carregar(); });
  const novo = $('#novo', alvo);
  if (novo) novo.onclick = () => novoEmprestimo((e) => { location.hash = `#/emprestimos/${e.id}`; });
  await carregar();
}

export async function detalheEmprestimo({ alvo, id, ativo }) {
  const e = await api.get(`/emprestimos/${id}`);
  if (!ativo()) return;
  definirTitulo(`Empréstimo #${e.id}`);
  const pagas = e.parcelas.filter((p) => p.status === 'paga').length;
  const proxima = e.parcelas.find((p) => p.status === 'aberta');
  alvo.innerHTML = String(html`
    <div class="page-head"><div><a href="#/emprestimos" class="small">← Empréstimos</a><h1 style="margin-top:4px">Empréstimo #${e.id} ${status(e.status)}</h1>
      <p class="muted"><a href="#/clientes/${e.cliente_id}">${e.cliente_nome}</a> · conta <a href="#/contas/${e.conta_id}">${e.agencia} / ${e.numero}-${e.digito}</a> · contratado em ${data(e.criado_em)}</p></div></div>
    <div class="grid grid-4">
      <div class="card kpi azul"><div class="rotulo">Valor contratado</div><div class="valor">${moeda(e.valor_centavos)}</div><div class="sub">Taxa ${pct(e.taxa_mensal)} a.m.</div></div>
      <div class="card kpi"><div class="rotulo">Parcela</div><div class="valor">${moeda(e.valor_parcela_centavos)}</div><div class="sub">${e.num_parcelas} parcelas</div></div>
      <div class="card kpi verde"><div class="rotulo">Pagas</div><div class="valor">${pagas} / ${e.num_parcelas}</div><div class="barra-h" style="margin-top:8px"><span style="width:${((pagas / e.num_parcelas) * 100).toFixed(1)}%"></span></div></div>
      <div class="card kpi vermelho"><div class="rotulo">Saldo devedor</div><div class="valor">${moeda(e.saldo_devedor_centavos)}</div><div class="sub">${proxima ? `Próxima: ${data(proxima.vencimento)}` : 'Quitado'}</div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Parcelas</h2></div><div class="table-wrap"><table>
      <thead><tr><th>Nº</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th><th>Pagamento</th><th></th></tr></thead><tbody>
      ${e.parcelas.map((p) => html`<tr><td>${p.numero}</td><td>${data(p.vencimento)}</td><td class="num">${moeda(p.valor_centavos)}</td>
        <td>${p.status === 'aberta' && p.vencimento < hoje() ? status('vencida') : status(p.status)}</td><td>${p.paga_em ? data(p.paga_em) : '—'}</td>
        <td class="right small muted">${proxima && p.numero === proxima.numero && e.status === 'ativo' ? 'Próxima a pagar (cliente, no Internet Banking)' : ''}</td></tr>`)}
      </tbody></table></div></div>`);

}
