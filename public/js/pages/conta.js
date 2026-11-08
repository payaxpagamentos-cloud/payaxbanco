import { api, sessao } from '../api.js';
import { html, raw, $, modal, toast, marca, dadosForm } from '../ui.js';


/** Passo a passo para ativar o aplicativo autenticador. `rotas`: prefixo da API (equipe ou Portal). */
export async function passos2fa(el, { prefixo = '/auth', aoAtivar }) {
  const ini = await api.post(`${prefixo}/2fa/iniciar`);
  el.innerHTML = String(html`<ol style="margin:0 0 12px;padding-left:18px;line-height:1.7">
      <li>Instale um aplicativo autenticador no celular (Google Authenticator, Microsoft Authenticator ou Authy).</li>
      <li>No aplicativo, leia o QR Code abaixo.</li>
      <li>Digite o código de 6 dígitos que aparecer.</li></ol>
    <div class="row" style="gap:20px;align-items:center">
      <div class="qr-pix" style="width:180px">${raw(ini.qr_svg)}</div>
      <div class="small muted" style="max-width:260px">Sem câmera? Digite esta chave no aplicativo:<br><code class="mono" style="word-break:break-all;color:var(--text)">${ini.segredo.match(/.{1,4}/g).join(' ')}</code></div>
    </div>
    <form id="form-2fa" class="row" style="margin-top:16px" novalidate>
      <input name="codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="width:160px;font-size:20px;letter-spacing:.25em;text-align:center" required>
      <button class="btn primario" type="submit">Ativar</button><span class="small neg" id="erro-2fa"></span>
    </form>`);
  $('#form-2fa', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post(`${prefixo}/2fa/ativar`, { codigo: e.target.codigo.value });
      aoAtivar(r);
    } catch (err) { $('#erro-2fa', el).textContent = err.message; }
  });
}

/** Tela cheia quando a 2FA é obrigatória e o usuário ainda não configurou. */
export function configurar2fa(alvo, { aoConcluir }) {
  alvo.innerHTML = String(html`<div class="login"><div class="card" style="width:min(560px,100%);padding:28px">
    <div style="margin-bottom:14px">${marca('clara')}</div>
    <h1 style="margin-bottom:6px">Ative a verificação em duas etapas</h1>
    <p class="muted" style="margin-top:0">O administrador tornou obrigatória a verificação em duas etapas para a equipe. Configure agora para continuar.</p>
    <div id="passos"><div class="carregando">Carregando…</div></div>
    <p class="small" style="margin-top:16px"><a href="#/login" id="sair">Sair</a></p></div></div>`);
  $('#sair', alvo).addEventListener('click', () => { sessao.limpar(); });
  passos2fa($('#passos', alvo), { aoAtivar: (r) => { toast('Verificação em duas etapas ativada.'); aoConcluir(r.token); } })
    .catch((err) => { $('#passos', alvo).textContent = err.message; });
}

/** Minha conta: senha e verificação em duas etapas. */
export async function minhaConta(alterarSenha) {
  const { usuario, exigir_2fa: exigida } = await api.get('/auth/me');
  const alcada = usuario.alcada_aprovacao_centavos === -1 ? 'Sem limite' : usuario.alcada_aprovacao_centavos === 0 ? 'Não aprova pagamentos'
    : (usuario.alcada_aprovacao_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const { el, fechar } = modal({
    titulo: 'Minha conta',
    corpo: html`<dl class="dl" style="margin-bottom:18px"><div><dt>Nome</dt><dd>${usuario.nome}</dd></div><div><dt>E-mail</dt><dd>${usuario.email}</dd></div>
        <div><dt>Alçada de aprovação</dt><dd>${alcada}</dd></div></dl>
      <div class="card card-body" style="box-shadow:none"><div class="row" style="justify-content:space-between">
        <div><strong>Verificação em duas etapas</strong><div class="small muted">${usuario.totp_ativo ? 'Ativa: o login pede o código do aplicativo.' : 'Desativada.'}${exigida ? ' Obrigatória para a equipe.' : ''}</div></div>
        ${usuario.totp_ativo ? (exigida ? '' : html`<button class="btn sm perigo" id="desativar">Desativar</button>`) : html`<button class="btn sm primario" id="ativar">Ativar</button>`}
      </div><div id="area-2fa" style="margin-top:12px"></div></div>`,
    rodape: html`<div class="modal-foot"><button class="btn" id="senha">Alterar senha</button><button class="btn" data-cancelar>Fechar</button></div>`,
  });
  $('#senha', el).addEventListener('click', () => { fechar(); alterarSenha(); });
  $('#ativar', el)?.addEventListener('click', (e) => {
    e.target.disabled = true;
    passos2fa($('#area-2fa', el), { aoAtivar: (r) => { sessao.set({ ...sessao.get(), token: r.token }); fechar(); toast('Verificação em duas etapas ativada.'); } })
      .catch((err) => toast(err.message, 'erro'));
  });
  $('#desativar', el)?.addEventListener('click', () => {
    fechar();
    modal({
      titulo: 'Desativar verificação em duas etapas',
      corpo: html`<div class="form"><div class="c6"><label>Senha</label><input type="password" name="senha" required autocomplete="current-password"></div>
        <div class="c6"><label>Código do aplicativo</label><input name="codigo" inputmode="numeric" maxlength="6" required></div></div>`,
      rotuloEnviar: 'Desativar',
      aoEnviar: async (form, f) => { await api.post('/auth/2fa/desativar', dadosForm(form)); f(); toast('Verificação em duas etapas desativada.'); },
    });
  });
}
