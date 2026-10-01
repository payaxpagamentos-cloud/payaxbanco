import { api } from '../api.js';
import { html, $$, moeda, data, pct, toast } from '../../../js/ui.js';
import { confirmarComPin, linhaRecibo } from '../comum.js';

const hoje = () => new Date().toISOString().slice(0, 10);

export default async function emprestimos(alvo) {
  const lista = await api.get('/emprestimos');
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Empréstimos</h1><p class="muted">Acompanhe seus contratos e pague parcelas com o saldo da conta.</p></div></div>
    ${lista.length ? html`<div class="stack">${lista.map((e) => {
      const pagas = e.parcelas.filter((p) => p.status === 'paga').length;
      const prox = e.parcelas.find((p) => p.status === 'aberta');
      const saldo = e.parcelas.filter((p) => p.status === 'aberta').reduce((a, p) => a + p.valor_centavos, 0);
      return html`<div class="card"><div class="card-head"><div><h2>Contrato #${e.id}</h2><div class="small muted">${moeda(e.valor_centavos)} · ${e.num_parcelas}× ${moeda(e.valor_parcela_centavos)} · ${pct(e.taxa_mensal)} a.m.</div></div>
        <span class="badge ${e.status === 'ativo' ? 'info' : 'ok'}">${e.status === 'ativo' ? 'Em dia' : 'Quitado'}</span></div>
        <div class="card-body stack">
          <div><div class="row small" style="justify-content:space-between"><span>${pagas} de ${e.num_parcelas} parcelas pagas</span><span>Saldo devedor <strong>${moeda(saldo)}</strong></span></div>
            <div class="barra-h" style="margin-top:6px"><span style="width:${((pagas / e.num_parcelas) * 100).toFixed(1)}%"></span></div></div>
          ${prox ? html`<div class="destinatario" style="justify-content:space-between;flex-wrap:wrap"><div><strong>Parcela ${prox.numero}</strong>
            <div class="small muted">Vence ${data(prox.vencimento)} ${prox.vencimento < hoje() ? html`<span class="badge danger">vencida</span>` : ''}</div></div>
            <div class="row"><strong>${moeda(prox.valor_centavos)}</strong><button class="btn ouro" data-pagar="${e.id}:${prox.numero}:${prox.valor_centavos}">Pagar parcela</button></div></div>` : ''}
        </div></div>`;
    })}</div>` : html`<div class="card vazio">Você não tem empréstimos. Fale com seu gerente PAY AX para conhecer as opções de crédito.</div>`}`);
  $$('[data-pagar]', alvo).forEach((b) => b.addEventListener('click', async () => {
    const [id, numero, valor] = b.dataset.pagar.split(':').map(Number);
    const r = await confirmarComPin({
      titulo: 'Pagar parcela',
      resumo: html`<div class="recibo">${linhaRecibo('Contrato', `#${id}`)}${linhaRecibo('Parcela', String(numero))}${linhaRecibo('Valor', moeda(valor))}</div>`,
      executar: (pin) => api.post(`/emprestimos/${id}/parcelas/${numero}/pagar`, { pin }),
    });
    if (!r) return;
    toast(`Parcela ${numero} paga.`);
    emprestimos(alvo);
  }));
}
