import { api } from '../api.js';
import { html, raw, moeda, moedaSinal, numero, dataHora, TIPO_CONTA, TIPO_TRANSACAO } from '../ui.js';

function grafico(serie) {
  const W = 720, H = 240, M = { t: 12, r: 12, b: 28, l: 78 };
  const max = Math.max(1, ...serie.flatMap((d) => [d.entradas_centavos, d.saidas_centavos]));
  const passo = 10 ** Math.floor(Math.log10(max));
  const topo = Math.ceil(max / passo) * passo;
  const larg = (W - M.l - M.r) / serie.length;
  const y = (v) => M.t + (H - M.t - M.b) * (1 - v / topo);
  const curto = (c) => new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(c / 100);
  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = topo * f;
    return `<line class="grade" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">R$ ${curto(v)}</text>`;
  }).join('');
  const barras = serie.map((d, i) => {
    const x = M.l + i * larg;
    const b = Math.max(4, larg / 2 - 5);
    const rot = d.dia.slice(8, 10) + '/' + d.dia.slice(5, 7);
    return `<g><title>${rot}: entradas ${moeda(d.entradas_centavos)} · saídas ${moeda(d.saidas_centavos)}</title>
      <rect x="${x + larg / 2 - b - 1}" y="${y(d.entradas_centavos)}" width="${b}" height="${y(0) - y(d.entradas_centavos)}" rx="3" fill="#1565C0"/>
      <rect x="${x + larg / 2 + 1}" y="${y(d.saidas_centavos)}" width="${b}" height="${y(0) - y(d.saidas_centavos)}" rx="3" fill="#00C8FF"/>
      ${i % 2 === 0 ? `<text x="${x + larg / 2}" y="${H - 8}" text-anchor="middle">${rot}</text>` : ''}</g>`;
  }).join('');
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Entradas e saídas dos últimos 14 dias">${grade}${barras}</svg>`);
}

export default async function dashboard({ alvo, ativo }) {
  const d = await api.get('/dashboard');
  if (!ativo()) return;
  const totalTipo = d.porTipo.reduce((a, t) => a + Math.max(0, t.saldo_centavos), 0) || 1;
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Painel do banco</h1><p class="muted">Visão consolidada da operação PAY AX.</p></div>
      <div class="row"><a class="btn" href="#/clientes">+ Novo cliente</a><a class="btn ouro" href="#/contas">Abrir conta</a></div></div>
    <div class="grid grid-4">
      <div class="card kpi azul"><div class="rotulo">Saldo sob custódia</div><div class="valor">${moeda(d.contas.saldo_total_centavos)}</div>
        <div class="sub">${numero(d.contas.ativas)} contas ativas · ${numero(d.contas.bloqueadas)} bloqueadas</div></div>
      <div class="card kpi"><div class="rotulo">Clientes</div><div class="valor">${numero(d.clientes.total)}</div>
        <div class="sub">${numero(d.clientes.pf)} PF · ${numero(d.clientes.pj)} PJ · ${numero(d.clientes.ativos)} ativos</div></div>
      <div class="card kpi verde"><div class="rotulo">Movimentado hoje</div><div class="valor">${moeda(d.hoje.entradas_centavos + d.hoje.saidas_centavos)}</div>
        <div class="sub">${numero(d.hoje.transacoes)} lançamentos · entradas ${moeda(d.hoje.entradas_centavos)}</div></div>
      <div class="card kpi vermelho"><div class="rotulo">Carteira de crédito</div><div class="valor">${moeda(d.carteira.saldo_devedor_centavos)}</div>
        <div class="sub">${numero(d.carteira.ativos)} contratos · vencido ${moeda(d.carteira.vencido_centavos)}</div></div>
    </div>
    <div class="grid grid-2-1" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Fluxo dos últimos 14 dias</h2>
        <div class="legenda"><span><i style="background:#1565C0"></i>Entradas</span><span><i style="background:#00C8FF"></i>Saídas</span></div></div>
        <div class="card-body">${grafico(d.serie)}</div></div>
      <div class="card"><div class="card-head"><h2>Saldo por tipo de conta</h2></div><div class="card-body stack">
        ${d.porTipo.length ? d.porTipo.map((t) => html`<div><div class="row" style="justify-content:space-between"><span>${TIPO_CONTA[t.tipo]} <span class="muted small">(${t.quantidade})</span></span><strong class="num">${moeda(t.saldo_centavos)}</strong></div>
          <div class="barra-h" style="margin-top:6px"><span style="width:${Math.max(2, (Math.max(0, t.saldo_centavos) / totalTipo) * 100).toFixed(1)}%"></span></div></div>`) : html`<div class="muted">Nenhuma conta aberta.</div>`}
        <div class="row" style="justify-content:space-between;border-top:1px solid var(--border);padding-top:12px"><span class="muted">Limite concedido</span><strong>${moeda(d.contas.limite_concedido_centavos)}</strong></div>
        <div class="row" style="justify-content:space-between"><span class="muted">Saldo devedor em conta</span><strong class="neg">${moeda(d.contas.saldo_negativo_centavos)}</strong></div>
      </div></div>
    </div>
    <div class="grid grid-2-1" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Últimas transações</h2><a href="#/transacoes" class="small">Ver todas →</a></div>
        <div class="table-wrap"><table><thead><tr><th>Data</th><th>Cliente</th><th>Tipo</th><th class="num">Valor</th></tr></thead><tbody>
        ${d.ultimas.length ? d.ultimas.map((t) => html`<tr class="clicavel" data-href="#/contas/${t.conta_id}"><td class="small">${dataHora(t.criado_em)}</td><td>${t.cliente_nome}<div class="small muted">Conta ${t.conta}</div></td><td>${TIPO_TRANSACAO[t.tipo] ?? t.tipo}</td><td class="num">${moedaSinal(t.valor_centavos)}</td></tr>`)
          : html`<tr><td colspan="4" class="vazio">Nenhuma transação ainda.</td></tr>`}
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><h2>Maiores clientes</h2></div><div class="table-wrap"><table><tbody>
        ${d.maiores.length ? d.maiores.map((c, i) => html`<tr class="clicavel" data-href="#/clientes/${c.id}"><td style="width:28px" class="muted">${i + 1}</td><td>${c.nome}<div class="small muted">${c.tipo}</div></td><td class="num">${moeda(c.saldo_centavos)}</td></tr>`)
          : html`<tr><td class="vazio">Sem dados.</td></tr>`}
      </tbody></table></div></div>
    </div>`);
  alvo.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
}
