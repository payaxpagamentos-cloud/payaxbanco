import { api } from '../api.js';
import { html, $$, moeda, numero, data, status, pct, toast, icone } from '../ui.js';
import { novoLancamento, detalheLancamento } from './comum.js';

const bloco = (titulo, x, classe = '') => html`<div class="row" style="justify-content:space-between">
  <span class="muted">${titulo} <span class="small">(${numero(x.quantidade)})</span></span><strong class="num ${classe}">${moeda(x.total_centavos)}</strong></div>`;

export default async function visao({ alvo, ativo, base, empresa }) {
  const r = await api.get(`${base}/resumo`);
  if (!ativo()) return;
  const res = r.resultado_mes;
  const semContas = !r.contas.length;
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>${empresa.nome_fantasia || empresa.razao_social}</h1><p class="muted">Posição financeira em ${data(r.hoje)}.</p></div>
      <div class="row"><button class="btn" data-novo="receber">+ A receber</button><button class="btn primario" data-novo="pagar">+ A pagar</button></div></div>
    ${semContas ? html`<div class="card card-body" style="margin-bottom:16px;background:var(--warn-bg);border:0">
      <strong>Comece pelos cadastros:</strong> inclua as contas bancárias da empresa (com o saldo inicial) em <a href="#/e/${empresa.id}/cadastros">Cadastros</a>.</div>` : ''}
    ${r.alerta_caixa.falta ? html`<div class="alerta perigo">${icone('escudo')}<div><strong>Falta de caixa prevista em ${data(r.alerta_caixa.data)}:</strong>
      o saldo projetado chega a ${moeda(r.alerta_caixa.saldo_centavos)} considerando as contas em aberto dos próximos ${r.alerta_caixa.dias} dias.
      <a href="#/e/${empresa.id}/fluxo">Ver fluxo de caixa</a></div></div>` : ''}
    ${r.aprovacoes_pendentes ? html`<div class="alerta aviso">${icone('check')}<div>${numero(r.aprovacoes_pendentes)} pagamento(s) aguardando conferência ou aprovação. <a href="#/e/${empresa.id}/aprovacoes">Abrir aprovações</a></div></div>` : ''}
    <div class="saldo-hero">
      <div><div class="rotulo">Saldo em contas</div><div class="valor">${moeda(r.saldo_total_centavos)}</div>
        <div class="rotulo" style="margin-top:6px">${numero(r.contas.filter((c) => c.ativo).length)} conta(s) ativa(s)${r.extrato_pendente ? ` · ${numero(r.extrato_pendente)} linha(s) de extrato a conciliar` : ''}</div></div>
      <div class="meta">
        <div><div class="rotulo">Resultado do mês (competência)</div><div style="font-size:20px;font-weight:750">${moeda(res.lucro_liquido)}</div></div>
        <div><div class="rotulo">Receita bruta do mês</div><div style="font-size:20px;font-weight:750">${moeda(res.receita_bruta)}</div></div>
        <div><div class="rotulo">Margem líquida</div><div style="font-size:20px;font-weight:750">${res.margem_liquida === null ? '—' : pct(res.margem_liquida)}</div></div>
      </div>
    </div>
    <div class="grid grid-3" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>A pagar</h2><a class="small" href="#/e/${empresa.id}/pagar">Abrir →</a></div><div class="card-body stack" style="gap:10px">
        ${bloco('Vencidos', r.pagar.vencidos, r.pagar.vencidos.quantidade ? 'neg' : '')}${bloco('Hoje', r.pagar.hoje)}${bloco('Próximos 7 dias', r.pagar.semana)}</div></div>
      <div class="card"><div class="card-head"><h2>A receber</h2><a class="small" href="#/e/${empresa.id}/receber">Abrir →</a></div><div class="card-body stack" style="gap:10px">
        ${bloco('Vencidos', r.receber.vencidos, r.receber.vencidos.quantidade ? 'neg' : '')}${bloco('Hoje', r.receber.hoje)}${bloco('Próximos 7 dias', r.receber.semana)}
        <div class="row" style="justify-content:space-between;border-top:1px solid var(--border);padding-top:10px"><a class="muted" href="#/e/${empresa.id}/cobranca">Inadimplência (90 dias)</a>
          <strong class="${r.inadimplencia.taxa_90_dias > 0.05 ? 'neg' : ''}">${r.inadimplencia.taxa_90_dias === null ? '—' : pct(r.inadimplencia.taxa_90_dias)}</strong></div></div></div>
      <div class="card"><div class="card-head"><h2>Contas bancárias</h2><a class="small" href="#/e/${empresa.id}/conciliacao">Conciliar →</a></div><div class="card-body stack" style="gap:10px">
        ${r.contas.length ? r.contas.filter((c) => c.ativo).map((c) => html`<div class="row" style="justify-content:space-between"><span>${c.descricao} <span class="small muted">${c.banco}</span>
          ${c.extrato_pendente ? html` <span class="badge warn">${numero(c.extrato_pendente)}</span>` : ''}</span><strong class="num ${c.saldo_centavos < 0 ? 'neg' : ''}">${moeda(c.saldo_centavos)}</strong></div>`)
          : html`<span class="muted">Nenhuma conta cadastrada.</span>`}</div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Vencidos e próximos 7 dias</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Vencimento</th><th>Tipo</th><th>Descrição</th><th>Contato</th><th class="num">Valor</th><th>Situação</th></tr></thead><tbody>
        ${r.proximos.length ? r.proximos.map((l) => html`<tr class="clicavel" data-id="${l.id}"><td>${data(l.vencimento)}</td>
          <td>${l.tipo === 'pagar' ? html`<span class="badge danger">Pagar</span>` : html`<span class="badge ok">Receber</span>`}</td>
          <td>${l.descricao}</td><td>${l.contato_nome ?? '—'}</td><td class="num">${moeda(l.valor_centavos)}</td><td>${status(l.situacao)}</td></tr>`)
          : html`<tr><td colspan="6" class="vazio">Nada vencido nem vencendo nos próximos 7 dias.</td></tr>`}
      </tbody></table></div></div>`);
  $$('[data-novo]', alvo).forEach((b) => b.addEventListener('click', () => novoLancamento(base, b.dataset.novo)));
  $$('tr[data-id]', alvo).forEach((tr) => tr.addEventListener('click', () => detalheLancamento(base, tr.dataset.id).catch((err) => toast(err.message, 'erro'))));
}
