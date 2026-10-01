import { api, sessao } from '../api.js';
import { html, $ } from '../ui.js';

export default function login(alvo, aoEntrar) {
  document.title = 'Entrar · Banqueiro PAY AX';
  alvo.innerHTML = String(html`
    <div class="login">
      <section class="lado">
        <img src="/img/logo-payax-branco.svg" alt="PAY AX" style="height:52px;align-self:flex-start">
        <div style="position:relative;z-index:1">
          <h2>Gestão bancária completa, <span>em um só lugar.</span></h2>
          <p>Clientes, contas, PIX, transferências, empréstimos e auditoria — o Banqueiro reúne toda a operação da PAY AX com segurança e controle por perfil.</p>
        </div>
        <div class="small" style="color:#7F93B8;position:relative;z-index:1">© ${new Date().getFullYear()} PAY AX · Banqueiro</div>
      </section>
      <section class="form-lado">
        <form id="form-login" novalidate>
          <img src="/img/logo-payax.svg" alt="PAY AX" style="height:44px;margin-bottom:8px" class="logo-claro">
          <div><h1>Acessar o Banqueiro</h1><p class="muted" style="margin:4px 0 8px">Entre com suas credenciais corporativas.</p></div>
          <div class="erro-form hidden" id="erro"></div>
          <div><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required></div>
          <div><label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required></div>
          <button class="btn primario" type="submit">Entrar</button>
          <p class="small muted" style="margin:0">Acesso restrito a colaboradores autorizados. Todas as ações são registradas em auditoria.</p>
        </form>
      </section>
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
