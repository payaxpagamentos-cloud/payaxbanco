import { api } from '../api.js';
import { html, $, $$, numero, moeda, dataHora, documento, modal, toast } from '../ui.js';
import { barras } from '../graficos.js';

const SEV = { alta: ['Alto risco', 'danger'], media: ['Médio', 'warn'], baixa: ['Baixo', 'info'] };
const ST = { aberto: ['Aberto', 'warn'], confirmado: ['Fraude confirmada', 'danger'], descartado: ['Descartado', ''] };
const MOTIVO = {
  senha_incorreta: 'Senha incorreta', senha_incorreta_bloqueou: 'Senha incorreta · acesso bloqueado', documento_sem_acesso: 'CPF/CNPJ sem acesso',
  acesso_bloqueado: 'Acesso bloqueado', bloqueio_temporario: 'Em bloqueio temporário', usuario_inexistente: 'E-mail não cadastrado',
  usuario_inativo: 'Usuário inativo',
};
const CORES = { alta: '#D63B3B', media: '#E8A33D', baixa: '#1F8BFF' };
const sev = (s) => html`<span class="badge ${SEV[s][1]}">${SEV[s][0]}</span>`;
const st = (s) => html`<span class="badge ${ST[s][1]}">${ST[s][0]}</span>`;

function analisar(id, aoMudar) {
  api.get(`/antifraude/alertas/${id}`).then((a) => {
    const aberto = a.status === 'aberto';
    const { el, fechar } = modal({
      titulo: `Alerta #${a.id} · ${a.regra_rotulo}`,
      grande: true,
      corpo: html`<div class="row" style="margin-bottom:12px">${sev(a.severidade)} ${st(a.status)} <span class="small muted">ocorrido em ${dataHora(a.ocorrido_em)}</span></div>
        <p style="margin:0 0 14px;font-size:15px">${a.descricao}</p>
        <dl class="dl">
          ${a.cliente_id ? html`<div><dt>Cliente</dt><dd><a href="#/clientes/${a.cliente_id}" data-cancelar>${a.cliente_nome}</a><div class="small muted mono">${documento(a.cliente_documento)}</div></dd></div>` : ''}
          ${a.conta_id ? html`<div><dt>Conta</dt><dd><a href="#/contas/${a.conta_id}" data-cancelar>${a.conta_numero}</a></dd></div>` : ''}
          ${a.valor_centavos ? html`<div><dt>Valor</dt><dd class="num">${moeda(a.valor_centavos)}</dd></div>` : ''}
          ${a.dados?.ip ? html`<div><dt>IP</dt><dd class="mono">${a.dados.ip}</dd></div>` : ''}
          ${a.ib ? html`<div><dt>Internet Banking</dt><dd>${a.ib.status === 'ativo' ? 'Ativo' : 'Bloqueado'}</dd></div>` : ''}
          ${a.cliente_id ? html`<div><dt>Outros alertas do cliente</dt><dd>${a.outros_alertas}</dd></div>` : ''}
        </dl>
        ${a.transacao ? html`<div class="card card-body" style="margin-top:14px;box-shadow:none;background:var(--surface-2)"><strong>Transação #${a.transacao.id}</strong>
          <div class="small">${a.transacao.descricao} · ${moeda(Math.abs(a.transacao.valor_centavos))} · ${dataHora(a.transacao.criado_em)}</div></div>` : ''}
        ${a.acessos.length ? html`<h3 style="margin:16px 0 6px">Últimos acessos do cliente</h3><div class="table-wrap"><table><tbody>
          ${a.acessos.map((x) => html`<tr><td class="small">${dataHora(x.criado_em)}</td><td>${x.sucesso ? html`<span class="badge ok">Entrou</span>` : html`<span class="badge danger">${MOTIVO[x.motivo] ?? 'Falhou'}</span>`}</td><td class="mono small">${x.ip ?? '—'}</td></tr>`)}</tbody></table></div>` : ''}
        ${aberto ? html`<label for="parecer-af" style="margin-top:16px">Parecer da análise</label>
          <textarea id="parecer-af" placeholder="Ex.: contato com o cliente, que confirmou a operação."></textarea>
          ${a.cliente_id ? html`<div class="stack" style="gap:8px;margin-top:12px">
            <label class="check" for="bl-ib"><input type="checkbox" id="bl-ib" ${a.ib?.status === 'ativo' ? '' : 'disabled'}> Ao confirmar, bloquear o acesso do cliente ao Internet Banking</label>
            ${a.conta_id ? html`<label class="check" for="bl-conta"><input type="checkbox" id="bl-conta"> Ao confirmar, bloquear a conta (segue as regras da Ouvidoria)</label>` : ''}</div>` : ''}`
          : html`<div class="card card-body" style="margin-top:14px;box-shadow:none;background:${a.status === 'confirmado' ? 'var(--danger-bg)' : 'var(--surface-2)'}">
            <strong>Parecer</strong><p style="margin:6px 0 0">${a.parecer}</p><div class="small muted" style="margin-top:6px">${a.analisado_por_nome ?? '—'} · ${dataHora(a.analisado_em)}</div></div>`}`,
      rodape: html`<div class="modal-foot">${aberto
        ? html`<button class="btn" id="descartar">Descartar (falso positivo)</button><button class="btn perigo" id="confirmar">Confirmar fraude</button>`
        : html`<button class="btn primario" data-cancelar>Fechar</button>`}</div>`,
    });
    const decidir = (acao) => async (e) => {
      e.target.disabled = true;
      try {
        const r = await api.post(`/antifraude/alertas/${a.id}/decidir`, {
          acao, parecer: $('#parecer-af', el).value, bloquear_ib: $('#bl-ib', el)?.checked, bloquear_conta: $('#bl-conta', el)?.checked,
        });
        fechar();
        toast(acao === 'confirmar' ? `Fraude confirmada.${r.efeitos.length ? ` ${r.efeitos.join('. ')}.` : ''}` : 'Alerta descartado.');
        aoMudar(); window.dispatchEvent(new Event('payax:contadores'));
      } catch (err) { toast(err.message, 'erro'); e.target.disabled = false; }
    };
    const d = $('#descartar', el); if (d) d.onclick = decidir('descartar');
    const c = $('#confirmar', el); if (c) c.onclick = decidir('confirmar');
  }).catch((e) => toast(e.message, 'erro'));
}

export default async function antifraude({ alvo, ativo }) {
  const f = { dias: 14, status: 'aberto', severidade: '' };

  async function carregar() {
    const [p, alertas] = await Promise.all([
      api.get('/antifraude/painel', { dias: f.dias }),
      api.get('/antifraude/alertas', { status: f.status, severidade: f.severidade }),
    ]);
    if (!ativo()) return;
    const maxRegra = Math.max(1, ...p.por_regra.map((r) => r.total));
    alvo.innerHTML = String(html`
      <div class="page-head"><div><h1>Antifraude</h1><p class="muted">Transações fora do padrão e tentativas de acesso suspeitas no Internet Banking e no Banqueiro.</p></div>
        <div class="chips" id="af-dias">${[7, 14, 30].map((d) => html`<button class="chip ${f.dias === d ? 'ativo' : ''}" data-dias="${d}">${d} dias</button>`)}</div></div>

      <div class="grid grid-4">
        <div class="card kpi ${p.alta_abertos ? 'vermelho' : ''}"><div class="rotulo">Alertas abertos</div><div class="valor">${numero(p.abertos)}</div>
          <div class="sub">${numero(p.alta_abertos)} de alto risco · ${numero(p.confirmados)} fraude(s) confirmada(s) no período</div></div>
        <div class="card kpi"><div class="rotulo">Valor sob suspeita</div><div class="valor">${moeda(p.valor_sob_suspeita_centavos)}</div>
          <div class="sub">Soma dos alertas abertos com valor</div></div>
        <div class="card kpi ${p.acessos_24h.bloqueios ? 'vermelho' : ''}"><div class="rotulo">Acessos com falha (24 h)</div><div class="valor">${numero(p.acessos_24h.falhas)}</div>
          <div class="sub">${numero(p.acessos_24h.bloqueios)} bloqueio(s) · ${numero(p.acessos_24h.ips_falha)} IP(s) · ${numero(p.acessos_24h.falhas_equipe)} na equipe</div></div>
        <div class="card kpi azul"><div class="rotulo">Transações analisadas (24 h)</div><div class="valor">${numero(p.transacoes_24h.analisadas)}</div>
          <div class="sub">${moeda(p.transacoes_24h.valor_centavos)} em PIX, transferências e pagamentos</div></div>
      </div>

      <div class="grid grid-2-1" style="margin-top:16px">
        <div class="card"><div class="card-head"><h2>Alertas por dia</h2>
          <div class="legenda">${['alta', 'media', 'baixa'].map((s) => html`<span><i style="background:${CORES[s]}"></i>${SEV[s][0]}</span>`)}</div></div>
          <div class="card-body">${barras(p.serie.map((d) => ({ ...d, rotulo: `${d.dia.slice(8, 10)}/${d.dia.slice(5, 7)}` })),
            ['alta', 'media', 'baixa'].map((s) => ({ chave: s, cor: CORES[s], rotulo: SEV[s][0] })), { empilhar: true, titulo: 'Alertas por dia e risco' })}</div></div>
        <div class="card"><div class="card-head"><h2>Por regra</h2><span class="small muted">${p.dias} dias</span></div>
          <div class="card-body stack" style="gap:10px">${p.por_regra.length ? p.por_regra.map((r) => html`<div>
            <div class="row small" style="justify-content:space-between"><span>${r.rotulo}</span><strong>${r.total}${r.abertos ? html` <span class="muted">(${r.abertos} abertos)</span>` : ''}</strong></div>
            <div class="barra-h" style="margin-top:4px"><span style="width:${((r.total / maxRegra) * 100).toFixed(1)}%"></span></div></div>`) : html`<div class="muted">Nenhum alerta no período.</div>`}</div></div>
      </div>

      <div class="grid grid-2-1" style="margin-top:16px">
        <div class="card"><div class="card-head"><h2>Acessos com falha por hora (24 h)</h2>
          <div class="legenda"><span><i style="background:#1565C0"></i>Internet Banking</span><span><i style="background:#00C8FF"></i>Equipe</span></div></div>
          <div class="card-body">${barras(p.horas.map((h) => ({ ...h, rotulo: `${String(h.hora_local).padStart(2, '0')}h` })),
            [{ chave: 'ib', cor: '#1565C0', rotulo: 'Internet Banking' }, { chave: 'equipe', cor: '#00C8FF', rotulo: 'Equipe' }], { titulo: 'Falhas de acesso por hora', cadaRotulo: 3 })}</div></div>
        <div class="card"><div class="card-head"><h2>Clientes com mais alertas</h2></div>
          <div class="table-wrap"><table><tbody>${p.clientes.length ? p.clientes.map((c) => html`<tr class="clicavel" data-href="#/clientes/${c.cliente_id}">
            <td><strong>${c.nome}</strong><div class="small muted">último ${dataHora(c.ultimo)}</div></td>
            <td class="num">${c.alertas}${c.abertos ? html`<div class="small neg">${c.abertos} aberto(s)</div>` : ''}</td></tr>`) : html`<tr><td class="vazio">Nenhum cliente com alerta.</td></tr>`}</tbody></table></div></div>
      </div>

      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Alertas</h2>
        <div class="row"><div class="chips" id="af-status">${[['aberto', 'Abertos'], ['confirmado', 'Confirmados'], ['descartado', 'Descartados'], ['', 'Todos']].map(([k, r]) => html`<button class="chip ${f.status === k ? 'ativo' : ''}" data-st="${k}">${r}</button>`)}</div>
          <select id="af-sev" style="width:auto" aria-label="Risco"><option value="">Todos os riscos</option>${Object.entries(SEV).map(([k, [r]]) => html`<option value="${k}" ${f.severidade === k ? 'selected' : ''}>${r}</option>`)}</select></div></div>
        <div class="table-wrap"><table><thead><tr><th>Risco</th><th>Alerta</th><th>Cliente</th><th class="num">Valor</th><th>Ocorrido</th><th>Situação</th></tr></thead><tbody>
        ${alertas.length ? alertas.map((a) => html`<tr class="clicavel" data-alerta="${a.id}"><td>${sev(a.severidade)}</td>
          <td><strong>${a.regra_rotulo}</strong><div class="small muted" style="max-width:420px">${a.descricao}</div></td>
          <td>${a.cliente_nome ?? html`<span class="muted">—</span>`}</td><td class="num">${a.valor_centavos ? moeda(a.valor_centavos) : '—'}</td>
          <td class="small">${dataHora(a.ocorrido_em)}</td><td>${st(a.status)}${a.analisado_por_nome ? html`<div class="small muted">${a.analisado_por_nome}</div>` : ''}</td></tr>`)
          : html`<tr><td colspan="6" class="vazio">Nenhum alerta ${f.status === 'aberto' ? 'aberto' : 'neste filtro'}.</td></tr>`}</tbody></table></div></div>

      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Tentativas de acesso recentes</h2><span class="small muted">Internet Banking e Banqueiro</span></div>
        <div class="table-wrap"><table><thead><tr><th>Quando</th><th>Canal</th><th>Quem</th><th>Resultado</th><th>IP</th></tr></thead><tbody>
        ${p.tentativas.length ? p.tentativas.map((t) => html`<tr><td class="small">${dataHora(t.criado_em)}</td><td class="small">${t.canal === 'equipe' ? 'Banqueiro' : 'Internet Banking'}</td>
          <td>${t.cliente_nome ?? t.usuario_nome ?? ''}<div class="small muted mono">${t.identificador}</div></td>
          <td>${t.sucesso ? html`<span class="badge ok">Entrou</span>` : html`<span class="badge ${t.motivo === 'senha_incorreta_bloqueou' ? 'danger' : 'warn'}">${MOTIVO[t.motivo] ?? 'Falhou'}</span>`}</td>
          <td class="mono small">${t.ip ?? '—'}</td></tr>`) : html`<tr><td colspan="5" class="vazio">Nenhuma tentativa registrada.</td></tr>`}</tbody></table></div></div>`);

    $$('[data-dias]', alvo).forEach((b) => b.addEventListener('click', () => { f.dias = Number(b.dataset.dias); carregar(); }));
    $$('[data-st]', alvo).forEach((b) => b.addEventListener('click', () => { f.status = b.dataset.st; carregar(); }));
    $('#af-sev', alvo).addEventListener('change', (e) => { f.severidade = e.target.value; carregar(); });
    $$('[data-alerta]', alvo).forEach((tr) => tr.addEventListener('click', () => analisar(tr.dataset.alerta, carregar)));
    $$('tr[data-href]', alvo).forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
  }
  await carregar();
}
