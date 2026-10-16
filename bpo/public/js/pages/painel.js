import { api } from '../api.js';
import { html, moeda, numero, data, linksLinhas, toast } from '../ui.js';
import { usuarioAtual } from '../contexto.js';

const prazo = (venc, hoje) => (venc < hoje ? html`<span class="badge danger">Atrasada · ${data(venc)}</span>`
  : venc === hoje ? html`<span class="badge warn">Hoje</span>` : html`<span class="badge info">${data(venc)}</span>`);

export default async function painel({ alvo, ativo }) {
  const d = await api.get('/painel');
  if (!ativo()) return;
  const c = d.carteira;
  const t = d.tarefas;
  const primeiro = usuarioAtual().nome.split(' ')[0];
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Olá, ${primeiro}</h1><p class="muted">Rotina da carteira de hoje, ${data(d.hoje)}.</p></div>
      <div class="row"><a class="btn" href="#/tarefas">Ver tarefas</a><a class="btn primario" href="#/empresas">Empresas</a></div></div>
    <div class="grid grid-4">
      <div class="card kpi azul"><div class="rotulo">Empresas atendidas</div><div class="valor">${numero(c.ativas)}</div>
        <div class="sub">${numero(c.implantacao)} em implantação · ${numero(c.suspensas)} suspensas</div></div>
      <div class="card kpi verde"><div class="rotulo">Receita recorrente (mensalidades)</div><div class="valor">${moeda(c.mrr_centavos)}</div>
        <div class="sub">${numero(c.novas_mes)} contrato(s) novo(s) no mês</div></div>
      <div class="card kpi vermelho"><div class="rotulo">Tarefas atrasadas</div><div class="valor">${numero(t.atrasadas)}</div>
        <div class="sub">${numero(t.hoje)} para hoje · ${numero(t.semana)} nos próximos 7 dias</div></div>
      <div class="card kpi ${d.pendencias.some((p) => p.falta_caixa) ? 'vermelho' : ''}"><div class="rotulo">Risco de falta de caixa</div>
        <div class="valor">${numero(d.pendencias.filter((p) => p.falta_caixa).length)}</div>
        <div class="sub">Empresa(s) com saldo projetado negativo em 30 dias · ${numero(c.contratos_vencendo)} contrato(s) vencendo</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Pendências por empresa</h2><span class="small muted">Ordenadas pela urgência</span></div>
      <div class="table-wrap"><table><thead><tr><th>Empresa</th><th class="num">A pagar hoje</th><th class="num">Pagar vencidos</th>
        <th class="num">Receber vencidos</th><th class="num">Extrato a conciliar</th><th>Alertas</th></tr></thead><tbody>
        ${d.pendencias.length ? d.pendencias.map((p) => html`<tr class="clicavel" data-href="#/e/${p.id}/visao">
          <td><strong>${p.nome}</strong>${p.analista_nome ? html`<div class="small muted">${p.analista_nome}</div>` : html`<div class="small" style="color:var(--warn)">Sem analista</div>`}</td>
          <td class="num">${p.pagar_hoje ? html`${numero(p.pagar_hoje)} · ${moeda(p.pagar_hoje_centavos)}` : '—'}</td>
          <td class="num ${p.pagar_vencidos ? 'neg' : ''}">${numero(p.pagar_vencidos)}</td>
          <td class="num ${p.receber_vencidos ? 'neg' : ''}">${numero(p.receber_vencidos)}</td>
          <td class="num">${numero(p.extrato_pendente)}${p.ultimo_extrato ? html`<div class="small muted">até ${data(p.ultimo_extrato)}</div>` : html`<div class="small muted">sem extrato</div>`}</td>
          <td><div class="alerta-linha">
            ${p.falta_caixa ? html`<span class="badge danger" title="Saldo projetado: ${moeda(p.falta_caixa.saldo_centavos)}">Falta de caixa em ${data(p.falta_caixa.data)}</span>` : ''}
            ${p.aprovacoes ? html`<span class="badge warn">${numero(p.aprovacoes)} aprovação(ões)</span>` : ''}
            ${p.mensagens ? html`<span class="badge info">${numero(p.mensagens)} mensagem(ns)</span>` : ''}
            ${p.tarefas_atrasadas ? html`<span class="badge danger">${numero(p.tarefas_atrasadas)} tarefa(s) atrasada(s)</span>` : ''}
            ${!p.falta_caixa && !p.aprovacoes && !p.mensagens && !p.tarefas_atrasadas ? html`<span class="muted small">—</span>` : ''}</div></td></tr>`)
          : html`<tr><td colspan="6" class="vazio">Nenhuma empresa ativa na carteira.</td></tr>`}
      </tbody></table></div>
    </div>

    <div class="grid ${d.por_analista ? 'grid-2' : ''}" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Próximas tarefas</h2><a class="small" href="#/tarefas">Todas →</a></div>
        <div class="table-wrap"><table><tbody>
          ${d.proximas.length ? d.proximas.map((x) => html`<tr>
            <td><strong>${x.titulo}</strong><div class="small muted"><a href="#/e/${x.empresa_id}/visao">${x.empresa_nome}</a>${x.responsavel_nome ? ` · ${x.responsavel_nome}` : ''}</div></td>
            <td class="right">${prazo(x.vencimento, d.hoje)}</td>
            <td class="right" style="width:110px"><button class="btn sm" data-concluir="${x.id}">Concluir</button></td></tr>`)
            : html`<tr><td class="vazio">Nenhuma tarefa nos próximos 7 dias.</td></tr>`}
        </tbody></table></div></div>
      ${d.por_analista ? html`<div class="card"><div class="card-head"><h2>Carteira por analista</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Analista</th><th class="num">Empresas</th><th class="num">Mensalidades</th><th class="num">Tarefas atrasadas</th></tr></thead><tbody>
          ${d.por_analista.length ? d.por_analista.map((a) => html`<tr><td>${a.nome}</td><td class="num">${numero(a.empresas)}</td><td class="num">${moeda(a.mrr_centavos)}</td>
            <td class="num ${a.tarefas_atrasadas ? 'neg' : ''}">${numero(a.tarefas_atrasadas)}</td></tr>`)
            : html`<tr><td colspan="4" class="vazio">Nenhum analista com carteira.</td></tr>`}
        </tbody></table></div></div>` : ''}
    </div>`);
  linksLinhas(alvo);
  alvo.querySelectorAll('[data-concluir]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api.post(`/tarefas/${b.dataset.concluir}/concluir`);
      toast(r.vencimento ? `Tarefa concluída. Próxima em ${data(r.vencimento)}.` : 'Tarefa concluída.');
      window.dispatchEvent(new Event('bpo:recarregar'));
    } catch (err) { toast(err.message, 'erro'); b.disabled = false; }
  }));
}
