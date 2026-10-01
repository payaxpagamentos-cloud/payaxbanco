import { api } from '../api.js';
import { html, $$, toast, icone } from '../ui.js';

const RELATORIOS = [
  { id: 'clientes', titulo: 'Cadastro de clientes', desc: 'Todos os clientes PF/PJ com contato, localização, renda e status.' },
  { id: 'contas', titulo: 'Posição de contas', desc: 'Saldos, limites e status de todas as contas, por titular.' },
  { id: 'transacoes', titulo: 'Movimentações', desc: 'Lançamentos do período, com operador responsável e estornos.', periodo: true },
  { id: 'emprestimos', titulo: 'Carteira de crédito', desc: 'Contratos, taxas, parcelas e saldo devedor.' },
];

export default async function relatorios({ alvo }) {
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Relatórios</h1><p class="muted">Exportações em CSV (separador “;”, compatível com Excel).</p></div></div>
    <div class="grid grid-2">
      ${RELATORIOS.map((r) => html`<div class="card card-body stack" style="gap:10px">
        <div><h2>${r.titulo}</h2><p class="muted" style="margin:4px 0 0">${r.desc}</p></div>
        ${r.periodo ? html`<div class="row"><div><label>De</label><input type="date" data-inicio="${r.id}"></div><div><label>Até</label><input type="date" data-fim="${r.id}"></div></div>` : ''}
        <div><button class="btn primario" data-rel="${r.id}">${icone('baixar')} Baixar CSV</button></div></div>`)}
    </div>`);
  $$('[data-rel]', alvo).forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.rel;
    const params = { inicio: alvo.querySelector(`[data-inicio="${id}"]`)?.value, fim: alvo.querySelector(`[data-fim="${id}"]`)?.value };
    b.disabled = true;
    try { await api.baixar(`/relatorios/${id}.csv`, params); } catch (e) { toast(e.message, 'erro'); } finally { b.disabled = false; }
  }));
}
