import { api, sessao } from '../api.js';
import { html, $, marca, icone } from '../ui.js';

export default function login(alvo, aoEntrar) {
  document.title = 'Entrar · BPO Financeiro PAY AX';
  alvo.innerHTML = String(html`
    <div class="login">
      <div class="login-cartao">
        <section class="lado bpo" aria-label="BPO Financeiro PAY AX">
          <span class="sobretitulo" style="color:#19E3FF">BPO Financeiro</span>
          <h2>O financeiro das empresas atendidas, em um só lugar.</h2>
          <p>Rotina diária da equipe PAY AX para a carteira de clientes.</p>
          <ul>
            <li>${icone('pagar')}Contas a pagar e a receber</li>
            <li>${icone('conciliar')}Conciliação bancária por OFX ou CSV</li>
            <li>${icone('fluxo')}Fluxo de caixa realizado e previsto</li>
            <li>${icone('dre')}DRE gerencial por competência ou caixa</li>
            <li>${icone('tarefas')}Carteira, contratos e rotinas da equipe</li>
          </ul>
        </section>
        <section class="form-lado">
          <form id="form-login" novalidate>
            <div style="align-self:center">${marca('clara')}</div>
            <div class="cabecalho-acesso"><h1>Acessar o BPO Financeiro</h1><p class="muted" style="margin:2px 0 4px">Entre com suas credenciais da equipe.</p></div>
            <div class="erro-form hidden" id="erro"></div>
            <div><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required></div>
            <div><label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required></div>
            <button class="btn primario" type="submit">Entrar</button>
            <p class="dica">Acesso restrito à equipe PAY AX. Ações registradas em auditoria.</p>
          </form>
        </section>
      </div>
      <div class="login-rodape">© ${new Date().getFullYear()} PAY AX · BPO Financeiro</div>
    </div>`);
  const form = $('#form-login', alvo);
  setTimeout(() => $('#email', alvo).focus(), 0);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', alvo);
    const botao = $('button', form);
    botao.disabled = true;
    erro.classList.add('hidden');
    try {
      const r = await api.post('/auth/login', { email: form.email.value, senha: form.senha.value });
      if (r.precisa_2fa) { pedirCodigo(alvo, r.desafio, aoEntrar); return; }
      sessao.set(r);
      alvo.innerHTML = '';
      aoEntrar();
    } catch (err) {
      erro.textContent = err.message;
      erro.classList.remove('hidden');
      botao.disabled = false;
    }
  });
}

/** Segunda etapa: código de 6 dígitos do aplicativo autenticador. */
function pedirCodigo(alvo, desafio, aoEntrar) {
  const form = $('#form-login', alvo);
  form.innerHTML = String(html`<div style="align-self:center">${marca('clara')}</div>
    <div class="cabecalho-acesso"><h1>Verificação em duas etapas</h1><p class="muted" style="margin:2px 0 4px">Digite o código de 6 dígitos do seu aplicativo autenticador.</p></div>
    <div class="erro-form hidden" id="erro"></div>
    <div><label for="codigo">Código</label><input id="codigo" name="codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required style="font-size:22px;letter-spacing:.3em;text-align:center"></div>
    <button class="btn primario" type="submit">Confirmar</button>
    <p class="dica"><a href="#/login" id="voltar">Voltar</a> · Perdeu o celular? Peça ao administrador para redefinir a verificação.</p>`);
  const novo = form.cloneNode(true);
  form.replaceWith(novo);
  $('#codigo', alvo).focus();
  $('#voltar', alvo).addEventListener('click', (e) => { e.preventDefault(); login(alvo, aoEntrar); });
  novo.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', alvo);
    try {
      sessao.set(await api.post('/auth/2fa/login', { desafio, codigo: novo.codigo.value }));
      alvo.innerHTML = '';
      aoEntrar();
    } catch (err) {
      erro.textContent = err.message;
      erro.classList.remove('hidden');
      novo.codigo.value = '';
      novo.codigo.focus();
      if (/Tempo esgotado/.test(err.message)) setTimeout(() => login(alvo, aoEntrar), 1500);
    }
  });
}
