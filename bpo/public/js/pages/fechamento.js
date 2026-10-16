import { api } from '../api.js';
import { html, $, $$, dataHora, toast, modal, dadosForm, hoje, somarMeses, rotuloMes, pct, icone } from '../ui.js';
import { gestor } from '../contexto.js';

const mesAnterior = () => somarMeses(hoje(), -1).slice(0, 7);
const opcoesMes = (sel) => Array.from({ length: 13 }, (_, i) => somarMeses(hoje(), -i).slice(0, 7))
  .map((m) => html`<option value="${m}" ${m === sel ? 'selected' : ''}>${rotuloMes(m)}</option>`);

/** Fechamento do mês de uma empresa: etapas, verificações automáticas, fechar e reabrir. */
export async function fechamentoEmpresa({ alvo, ativo, base }) {
  let mes = mesAnterior();
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Fechamento do mês</h1><p class="muted">Checklist do fechamento. Mês fechado não aceita lançamentos, baixas nem ajustes com data nele.</p></div>
      <select id="mes" class="campo" style="width:auto">${opcoesMes(mes)}</select></div>
    <div id="fech"></div>`);
  const carregar = async () => {
    const f = await api.get(`${base}/fechamento`, { mes });
    if (!ativo()) return;
    $('#fech', alvo).innerHTML = String(html`
      ${f.fechado ? html`<div class="alerta info">${icone('cadeado')}<div><strong>Mês fechado</strong> em ${dataHora(f.fechado.concluido_em)} por ${f.fechado.usuario_nome}. Para corrigir algo, um supervisor precisa reabrir.</div></div>` : ''}
      <div class="grid grid-2-1" style="align-items:start">
        <div class="card"><div class="card-head"><h2>Etapas de ${rotuloMes(mes)}</h2><span class="small muted">${pct(f.progresso)} concluído</span></div>
          ${f.etapas.map((e) => html`<div class="etapa ${e.concluida ? 'feita' : ''}" data-etapa="${e.chave}">
            <span class="marca-etapa">${e.concluida ? '✓' : ''}</span>
            <div><strong>${e.rotulo}</strong>${e.auto ? html` <span class="badge">Verificação automática</span>` : ''}
              ${e.verificacao ? html`<div class="small ${e.verificacao.ok ? 'pos' : 'neg'}">${e.verificacao.detalhe}</div>` : ''}
              ${e.concluida ? html`<div class="small muted">Concluída por ${e.concluida.usuario_nome} em ${dataHora(e.concluida.concluido_em)}${e.concluida.observacao ? ` · ${e.concluida.observacao}` : ''}</div>` : ''}</div>
            <div>${f.fechado ? '' : e.concluida ? html`<button class="btn sm" data-desmarcar>Desmarcar</button>` : html`<button class="btn sm primario" data-marcar>Concluir</button>`}</div></div>`)}
          <div class="card-body row" style="justify-content:flex-end;border-top:1px solid var(--border)">
            ${f.fechado ? (gestor() ? html`<button class="btn perigo" id="reabrir">Reabrir mês</button>` : html`<span class="small muted">Só supervisor ou administrador reabre.</span>`)
              : html`<button class="btn primario" id="fechar" ${f.pode_fechar ? '' : 'disabled'}>Fechar ${rotuloMes(mes)}</button>`}</div></div>
        <div class="card"><div class="card-head"><h2>Meses fechados</h2></div><div class="table-wrap"><table><tbody>
          ${f.historico.length ? f.historico.map((h) => html`<tr><td>${rotuloMes(h.mes)}</td><td class="small muted">${dataHora(h.concluido_em)} · ${h.usuario_nome ?? ''}</td></tr>`)
            : html`<tr><td class="vazio">Nenhum mês fechado ainda.</td></tr>`}</tbody></table></div></div>
      </div>`);
    const etapa = (el) => f.etapas.find((e) => e.chave === el.closest('[data-etapa]').dataset.etapa);
    $$('[data-marcar]', alvo).forEach((b) => b.addEventListener('click', () => {
      const e = etapa(b);
      const pendente = e.verificacao && !e.verificacao.ok;
      modal({
        titulo: e.rotulo,
        corpo: html`${pendente ? html`<div class="alerta aviso">${e.verificacao.detalhe} Para concluir mesmo assim, explique.</div>` : ''}
          <label>Observação${pendente ? '' : ' (opcional)'}</label><textarea name="observacao" ${pendente ? 'required' : ''}></textarea>`,
        rotuloEnviar: 'Concluir etapa',
        aoEnviar: async (form, fechar) => { await api.post(`${base}/fechamento/etapas`, { mes, etapa: e.chave, concluir: true, observacao: dadosForm(form).observacao }); fechar(); carregar(); },
      });
    }));
    $$('[data-desmarcar]', alvo).forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`${base}/fechamento/etapas`, { mes, etapa: etapa(b).chave, concluir: false }); carregar(); } catch (err) { toast(err.message, 'erro'); }
    }));
    $('#fechar', alvo)?.addEventListener('click', async () => {
      try { await api.post(`${base}/fechamento/fechar`, { mes }); toast(`${rotuloMes(mes)} fechado.`); carregar(); } catch (err) { toast(err.message, 'erro'); }
    });
    $('#reabrir', alvo)?.addEventListener('click', () => modal({
      titulo: `Reabrir ${rotuloMes(mes)}`,
      corpo: html`<p style="margin-top:0">Reabre este mês e os meses seguintes que estiverem fechados. Fica registrado na auditoria.</p><label>Motivo</label><textarea name="motivo" required></textarea>`,
      rotuloEnviar: 'Reabrir',
      aoEnviar: async (form, fechar) => { await api.post(`${base}/fechamento/reabrir`, { mes, motivo: dadosForm(form).motivo }); fechar(); toast('Mês reaberto.'); carregar(); },
    }));
  };
  $('#mes', alvo).addEventListener('change', (e) => { mes = e.target.value; carregar(); });
  await carregar();
}

/** Acompanhamento do fechamento de toda a carteira. */
export async function fechamentoCarteira({ alvo, ativo }) {
  let mes = mesAnterior();
  alvo.innerHTML = String(html`<div class="page-head"><div><h1>Fechamento mensal da carteira</h1><p class="muted">Andamento do fechamento de cada empresa.</p></div>
    <select id="mes" class="campo" style="width:auto">${opcoesMes(mes)}</select></div><div id="cart"></div>`);
  const carregar = async () => {
    const r = await api.get('/carteira/fechamento', { mes });
    if (!ativo()) return;
    const fechadas = r.empresas.filter((e) => e.fechado).length;
    $('#cart', alvo).innerHTML = String(html`
      <div class="grid grid-3"><div class="card kpi verde"><div class="rotulo">Fechadas</div><div class="valor">${fechadas} de ${r.empresas.length}</div></div>
        <div class="card kpi"><div class="rotulo">Em andamento</div><div class="valor">${r.empresas.filter((e) => !e.fechado && e.progresso > 0).length}</div></div>
        <div class="card kpi vermelho"><div class="rotulo">Não iniciadas</div><div class="valor">${r.empresas.filter((e) => !e.progresso && !e.fechado).length}</div></div></div>
      <div class="card" style="margin-top:16px"><div class="table-wrap"><table><thead><tr><th>Empresa</th><th>Analista</th><th>Etapas</th><th>Progresso</th><th>Situação</th></tr></thead><tbody>
        ${r.empresas.map((e) => html`<tr class="clicavel" data-href="#/e/${e.id}/fechamento"><td><strong>${e.nome}</strong></td><td>${e.analista_nome ?? '—'}</td>
          <td><span class="pontos-etapas">${e.etapas.map((x) => html`<i class="${x.concluida ? 'ok' : x.ok === false ? 'aviso' : ''}" title="${r.etapas.find((y) => y.chave === x.chave).rotulo}"></i>`)}</span></td>
          <td style="min-width:140px"><div class="barra-h"><span style="width:${(e.progresso * 100).toFixed(0)}%"></span></div></td>
          <td>${e.fechado ? html`<span class="badge ok">Fechado</span>` : e.progresso ? html`<span class="badge warn">Em andamento</span>` : html`<span class="badge">Não iniciado</span>`}</td></tr>`)}
      </tbody></table></div><div class="card-body small muted">Quadrado verde: etapa concluída. Amarelo: verificação automática com pendência.</div></div>`);
    $$('tr[data-href]', alvo).forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
  };
  $('#mes', alvo).addEventListener('change', (e) => { mes = e.target.value; carregar(); });
  await carregar();
}
