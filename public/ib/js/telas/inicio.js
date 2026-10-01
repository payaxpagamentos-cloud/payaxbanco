import { html, $, moeda, data, icone } from '../../../js/ui.js';
import { estado, carregarResumo, contaAtual, rotuloConta, alternarSaldo, listaLancamentos, ligarComprovantes } from '../comum.js';

const ACOES = [
  { rota: 'pix', rotulo: 'PIX', icone: 'pix', destaque: true },
  { rota: 'pagar', rotulo: 'Pagar', icone: 'barras' },
  { rota: 'transferir', rotulo: 'Transferir', icone: 'operacoes' },
  { rota: 'pix/receber', rotulo: 'Receber', icone: 'qr' },
  { rota: 'extrato', rotulo: 'Extrato', icone: 'transacoes' },
  { rota: 'emprestimos', rotulo: 'Empréstimos', icone: 'emprestimos' },
];

export default async function inicio(alvo) {
  await carregarResumo();
  const r = estado.resumo;
  const c = contaAtual();
  if (!c) { alvo.innerHTML = String(html`<div class="card vazio">Você ainda não tem conta ativa. Procure a PAY AX.</div>`); return; }
  const oculto = estado.ocultarSaldo ? 'oculto' : '';
  const l = r.limite;
  alvo.innerHTML = String(html`
    <div class="saldo-card">
      <div class="topo">
        ${r.contas.length > 1 ? html`<select id="conta" aria-label="Conta">${r.contas.map((x) => html`<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${rotuloConta(x)}</option>`)}</select>`
          : html`<span class="small" style="color:#B9C8E3">${rotuloConta(c)}</span>`}
        <button class="olho" id="olho" aria-label="${estado.ocultarSaldo ? 'Mostrar saldo' : 'Ocultar saldo'}">${icone(estado.ocultarSaldo ? 'olhoFechado' : 'olho')}</button>
      </div>
      <div class="rotulo">Saldo disponível</div>
      <div class="valor ${oculto}">${moeda(c.saldo_centavos)}</div>
      <div class="rodape">
        ${c.limite_centavos ? html`<span>Limite <strong class="${oculto}">${moeda(c.limite_centavos)}</strong></span><span>Total disponível <strong class="${oculto}">${moeda(c.saldo_centavos + c.limite_centavos)}</strong></span>` : ''}
        <span>Limite diário restante <strong class="${oculto}">${moeda(l.disponivel_centavos)}</strong></span>
      </div>
    </div>
    <nav class="acoes" aria-label="Ações rápidas">
      ${ACOES.map((a) => html`<a class="acao ${a.destaque ? 'destaque' : ''}" href="#/${a.rota}"><span class="ic">${icone(a.icone)}</span>${a.rotulo}</a>`)}
    </nav>
    <div class="grid grid-2-1">
      <div class="card"><div class="card-head"><h2>Últimos lançamentos</h2><a href="#/extrato" class="small">Ver extrato →</a></div>
        <div id="lancs">${listaLancamentos(r.ultimas)}</div></div>
      <div class="stack">
        <div class="card card-body"><h3>Limite diário</h3>
          <p class="small muted" style="margin:4px 0 10px">PIX, transferências e pagamentos feitos hoje pelo Internet Banking.</p>
          <div class="barra-h"><span style="width:${Math.min(100, (l.usado_centavos / Math.max(1, l.limite_centavos)) * 100).toFixed(1)}%"></span></div>
          <div class="row small" style="justify-content:space-between;margin-top:6px"><span>Usado ${moeda(l.usado_centavos)}</span><span class="muted">de ${moeda(l.limite_centavos)}</span></div></div>
        ${r.emprestimos.length ? html`<a class="card card-body" href="#/emprestimos" style="color:inherit;text-decoration:none"><h3>Empréstimos</h3>
          ${r.emprestimos.map((e) => html`<div class="row small" style="justify-content:space-between;margin-top:8px"><span>Parcela ${e.pagas + 1}/${e.num_parcelas} · vence ${data(e.proximo_vencimento)}</span><strong>${moeda(e.valor_parcela_centavos)}</strong></div>`)}</a>` : ''}
      </div>
    </div>`);
  ligarComprovantes($('#lancs', alvo));
  $('#olho', alvo).onclick = () => { alternarSaldo(); inicio(alvo); };
  const sel = $('#conta', alvo);
  if (sel) sel.onchange = () => { estado.contaId = Number(sel.value); inicio(alvo); };
}
