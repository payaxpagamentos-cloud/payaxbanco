import { api } from '../api.js';
import { pode, usuarioAtual } from '../contexto.js';
import { html, $, $$, documento, dataHora, modal, toast } from '../ui.js';

const STATUS = { em_analise: ['Em análise', 'warn'], aprovada: ['Aprovada', 'ok'], recusada: ['Recusada', 'danger'], cancelada: ['Cancelada', ''] };
const pilula = (s) => html`<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const ALVO = { encerrada: 'Encerrar', bloqueada: 'Bloquear', ativa: 'Desbloquear', bloqueado: 'Bloquear', inativo: 'Inativar', ativo: 'Reativar' };
const origem = (s) => (s.origem === 'cliente' ? 'Cliente, pelo Internet Banking' : (s.solicitante_nome ?? 'Equipe'));

/** Mensagem padrão para quem pediu uma ação que foi para a Ouvidoria. */
export const avisoAnalise = (s) => `Enviado para análise da Ouvidoria · protocolo ${s.protocolo}.`;

function detalhe(id, aoMudar) {
  api.get(`/ouvidoria/${id}`).then((s) => {
    const eu = usuarioAtual();
    const decidir = pode('ouvidoria.decidir') && s.status === 'em_analise' && s.solicitante_id !== eu.id;
    const cancelar = s.status === 'em_analise' && (s.solicitante_id === eu.id || eu.perfil === 'admin');
    const { el, fechar } = modal({
      titulo: `Solicitação ${s.protocolo}`,
      grande: true,
      corpo: html`<div class="row" style="margin-bottom:14px">${pilula(s.status)} <strong>${s.tipo_rotulo}</strong>
          <span class="muted small">aberta em ${dataHora(s.criado_em)}</span></div>
        <dl class="dl">
          <div><dt>Cliente</dt><dd>${s.cliente_id ? html`<a href="#/clientes/${s.cliente_id}" data-cancelar>${s.cliente_nome}</a>` : s.cliente_nome}
            ${s.cliente_documento ? html`<div class="small muted mono">${documento(s.cliente_documento)}</div>` : ''}</dd></div>
          ${s.conta_id ? html`<div><dt>Conta</dt><dd><a href="#/contas/${s.conta_id}" data-cancelar>${s.agencia} / ${s.conta_numero}</a>
            <div class="small muted">Situação atual: ${s.conta_status}</div></dd></div>` : ''}
          <div><dt>Pedido</dt><dd>${ALVO[s.dados.status] ?? s.tipo_rotulo}${s.dados.status ? ` (${s.dados.status})` : ''}</dd></div>
          <div><dt>Solicitado por</dt><dd>${origem(s)}</dd></div>
          ${s.decidido_em ? html`<div><dt>${s.status === 'cancelada' ? 'Cancelada em' : 'Decidida por'}</dt><dd>${s.decisor_nome ?? '—'}<div class="small muted">${dataHora(s.decidido_em)}</div></dd></div>` : ''}
        </dl>
        <div class="card card-body" style="margin-top:14px;box-shadow:none;background:var(--surface-2)"><strong>Motivo informado</strong><p style="margin:6px 0 0;white-space:pre-wrap">${s.motivo}</p></div>
        ${s.parecer ? html`<div class="card card-body" style="margin-top:10px;box-shadow:none;background:${s.status === 'recusada' ? 'var(--danger-bg)' : 'var(--ok-bg)'}"><strong>Parecer da Ouvidoria</strong><p style="margin:6px 0 0;white-space:pre-wrap">${s.parecer}</p></div>` : ''}
        ${decidir ? html`<label for="parecer" style="margin-top:14px">Parecer (obrigatório para recusar)</label><textarea id="parecer" placeholder="Análise feita, documentos conferidos, contato com o cliente…"></textarea>
          <p class="small muted" style="margin:6px 0 0">Ao aprovar, a ação é executada imediatamente e registrada na auditoria com este protocolo.</p>` : ''}
        ${s.status === 'em_analise' && !decidir && pode('ouvidoria.decidir') ? html`<p class="small muted" style="margin:14px 0 0">Você abriu esta solicitação; ela precisa ser decidida por outra pessoa.</p>` : ''}`,
      rodape: html`<div class="modal-foot">
        ${cancelar ? html`<button class="btn" id="cancelar-sol">Cancelar solicitação</button>` : ''}
        ${decidir ? html`<button class="btn perigo" id="recusar">Recusar</button><button class="btn primario" id="aprovar">Aprovar e executar</button>`
          : html`<button class="btn primario" data-cancelar>Fechar</button>`}</div>`,
    });
    const acao = (caminho, msg) => async (e) => {
      e.target.disabled = true;
      try {
        await api.post(`/ouvidoria/${id}/${caminho}`, { parecer: $('#parecer', el)?.value });
        fechar(); toast(msg); aoMudar();
      } catch (err) { toast(err.message, 'erro'); e.target.disabled = false; }
    };
    const ap = $('#aprovar', el); if (ap) ap.onclick = acao('aprovar', 'Solicitação aprovada e executada.');
    const rc = $('#recusar', el); if (rc) rc.onclick = acao('recusar', 'Solicitação recusada.');
    const cc = $('#cancelar-sol', el); if (cc) cc.onclick = acao('cancelar', 'Solicitação cancelada.');
  }).catch((e) => toast(e.message, 'erro'));
}

export default async function ouvidoria({ alvo, ativo }) {
  let filtro = 'em_analise';
  const decide = pode('ouvidoria.decidir');
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Ouvidoria</h1><p class="muted">${decide
      ? 'Solicitações que precisam de análise antes de serem executadas: encerramentos, bloqueios e outras ações sensíveis.'
      : 'Acompanhe as solicitações enviadas para análise da Ouvidoria.'}</p></div></div>
    <div class="card">
      <div class="filtros"><div class="chips" id="filtro">
        <button class="chip ativo" data-f="em_analise">Em análise</button><button class="chip" data-f="aprovada">Aprovadas</button>
        <button class="chip" data-f="recusada">Recusadas</button><button class="chip" data-f="cancelada">Canceladas</button><button class="chip" data-f="">Todas</button></div></div>
      <div id="tabela"></div>
    </div>`);
  async function carregar() {
    const lista = await api.get('/ouvidoria', { status: filtro });
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>Protocolo</th><th>Pedido</th><th>Cliente</th><th>Conta</th><th>Solicitado por</th><th>Aberta</th><th>Situação</th></tr></thead><tbody>
      ${lista.length ? lista.map((s) => html`<tr class="clicavel" data-id="${s.id}"><td class="mono small">${s.protocolo}</td>
        <td><strong>${s.tipo_rotulo}</strong><div class="small muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.motivo}</div></td>
        <td>${s.cliente_nome}</td><td class="mono small">${s.conta_numero ?? '—'}</td>
        <td>${origem(s)}</td><td class="small">${dataHora(s.criado_em)}</td>
        <td>${pilula(s.status)}${s.decisor_nome ? html`<div class="small muted">por ${s.decisor_nome}</div>` : ''}</td></tr>`)
        : html`<tr><td colspan="7" class="vazio">Nenhuma solicitação ${filtro === 'em_analise' ? 'aguardando análise' : 'nesta situação'}.</td></tr>`}</tbody></table></div>`);
    $$('tr[data-id]', alvo).forEach((tr) => tr.addEventListener('click', () => detalhe(tr.dataset.id, carregar)));
  }
  $('#filtro', alvo).addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    filtro = b.dataset.f;
    $$('#filtro .chip', alvo).forEach((x) => x.classList.toggle('ativo', x === b));
    carregar();
  });
  await carregar();
}
