import { api } from '../api.js';
import { pode } from '../contexto.js';
import { html, $, $$, moeda, documento, telefone, dataHora, data, modal, toast, cep } from '../ui.js';

const STATUS = { em_analise: ['Em análise', 'warn'], aprovada: ['Aprovada', 'ok'], recusada: ['Recusada', 'danger'] };
const pilula = (s) => html`<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;

function mostrarAprovacao(r) {
  modal({
    titulo: 'Conta aberta',
    corpo: html`<p style="margin-top:0">Cliente <strong>${r.nome}</strong> cadastrado e conta <strong>${r.conta.agencia} / ${r.conta.numero}-${r.conta.digito}</strong> aberta.</p>
      <p>Entregue a senha provisória ao cliente por um canal seguro. Ela aparece <strong>só agora</strong>; no primeiro acesso o cliente cria a senha de acesso e a de transação.</p>
      <dl class="dl"><div><dt>Login</dt><dd class="mono">${documento(r.documento)}</dd></div><div><dt>Senha provisória</dt><dd class="mono" style="font-size:20px;letter-spacing:.08em">${r.senha_provisoria}</dd></div></dl>`,
    rodape: html`<div class="modal-foot"><a class="btn" href="#/clientes/${r.cliente_id}" data-cancelar>Ver cliente</a><button class="btn primario" data-cancelar>Concluir</button></div>`,
  });
}

function detalhe(id, aoMudar) {
  api.get(`/aberturas/${id}`).then((p) => {
    const d = p.dados;
    const decidir = pode('aberturas.decidir') && p.status === 'em_analise';
    const { el, fechar } = modal({
      titulo: `Proposta ${p.protocolo}`,
      grande: true,
      corpo: html`<div class="row" style="margin-bottom:14px">${pilula(p.status)} <span class="muted small">Enviada em ${dataHora(p.criado_em)}${p.analisado_em ? ` · analisada em ${dataHora(p.analisado_em)}` : ''}</span></div>
        <dl class="dl">
          <div><dt>${d.tipo === 'PF' ? 'Nome' : 'Razão social'}</dt><dd>${d.nome}</dd></div>
          <div><dt>${d.tipo === 'PF' ? 'CPF' : 'CNPJ'}</dt><dd class="mono">${documento(d.documento)}</dd></div>
          <div><dt>${d.tipo === 'PF' ? 'Nascimento' : 'Fundação'}</dt><dd>${data(d.data_nascimento)}</dd></div>
          <div><dt>E-mail</dt><dd>${d.email}</dd></div>
          <div><dt>Celular</dt><dd>${telefone(d.telefone)}</dd></div>
          <div><dt>${d.tipo === 'PF' ? 'Renda mensal' : 'Faturamento mensal'}</dt><dd>${moeda(d.renda_mensal_centavos)}</dd></div>
          <div><dt>Endereço</dt><dd>${d.logradouro}, ${d.numero}${d.complemento ? ` · ${d.complemento}` : ''}<br>${d.bairro} · ${d.cidade}/${d.uf} · CEP ${cep(d.cep)}</dd></div>
          <div><dt>Conta solicitada</dt><dd>${p.tipo_conta === 'corrente' ? 'Conta corrente' : 'Conta de pagamento'}</dd></div>
          <div><dt>IP de envio</dt><dd class="mono small">${p.ip ?? '—'}</dd></div>
        </dl>
        ${p.motivo ? html`<div class="card card-body" style="margin-top:14px;box-shadow:none;background:var(--danger-bg)"><strong>Motivo da recusa:</strong> ${p.motivo}</div>` : ''}
        ${decidir ? html`<div class="card card-body small" style="margin-top:14px;box-shadow:none;background:var(--info-bg)">Antes de aprovar, confira os dados e a documentação do cliente conforme a política de cadastro (KYC) da PAY AX.</div>` : ''}`,
      rodape: html`<div class="modal-foot">
        ${decidir ? html`<button class="btn perigo" id="recusar">Recusar</button><button class="btn primario" id="aprovar">Aprovar e abrir conta</button>`
          : html`${p.cliente_id ? html`<a class="btn" href="#/clientes/${p.cliente_id}" data-cancelar>Ver cliente</a>` : ''}<button class="btn primario" data-cancelar>Fechar</button>`}</div>`,
    });
    const ap = $('#aprovar', el);
    if (ap) ap.onclick = async () => {
      ap.disabled = true;
      try { const r = await api.post(`/aberturas/${id}/aprovar`); fechar(); mostrarAprovacao(r); aoMudar(); } catch (e) { toast(e.message, 'erro'); ap.disabled = false; }
    };
    const rc = $('#recusar', el);
    if (rc) rc.onclick = () => {
      fechar();
      modal({
        titulo: `Recusar proposta ${p.protocolo}`,
        rotuloEnviar: 'Recusar proposta',
        corpo: html`<label for="motivo-rec">Motivo (registro interno, não é mostrado ao interessado)</label><textarea id="motivo-rec" name="motivo"></textarea>`,
        aoEnviar: async (f, fecharRec) => { await api.post(`/aberturas/${id}/recusar`, { motivo: f.motivo.value }); fecharRec(); toast('Proposta recusada.'); aoMudar(); },
      });
    };
  }).catch((e) => toast(e.message, 'erro'));
}

export default async function aberturas({ alvo, ativo }) {
  let filtro = 'em_analise';
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Abertura de contas</h1><p class="muted">Propostas enviadas pelo site. Gerentes e administradores aprovam ou recusam.</p></div></div>
    <div class="card">
      <div class="filtros"><div class="chips" id="filtro">
        <button class="chip ativo" data-f="em_analise">Em análise</button><button class="chip" data-f="aprovada">Aprovadas</button>
        <button class="chip" data-f="recusada">Recusadas</button><button class="chip" data-f="">Todas</button></div></div>
      <div id="tabela"></div>
    </div>`);
  async function carregar() {
    const lista = await api.get('/aberturas', { status: filtro });
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>Protocolo</th><th>Interessado</th><th>Documento</th><th>Contato</th><th>Conta</th><th>Enviada</th><th>Situação</th></tr></thead><tbody>
      ${lista.length ? lista.map((p) => html`<tr class="clicavel" data-id="${p.id}"><td class="mono small">${p.protocolo}</td>
        <td><strong>${p.nome}</strong><div class="small muted">${p.tipo === 'PF' ? 'Pessoa física' : 'Pessoa jurídica'}</div></td>
        <td class="mono">${documento(p.documento)}</td><td>${p.email}<div class="small muted">${telefone(p.telefone)}</div></td>
        <td>${p.tipo_conta === 'corrente' ? 'Corrente' : 'Pagamento'}</td><td class="small">${dataHora(p.criado_em)}</td>
        <td>${pilula(p.status)}${p.analisado_por ? html`<div class="small muted">por ${p.analisado_por}</div>` : ''}</td></tr>`)
        : html`<tr><td colspan="7" class="vazio">Nenhuma proposta ${filtro === 'em_analise' ? 'aguardando análise' : 'nesta situação'}.</td></tr>`}</tbody></table></div>`);
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
