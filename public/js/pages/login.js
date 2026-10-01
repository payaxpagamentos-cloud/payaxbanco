import { api, sessao } from '../api.js';
import { html, $ } from '../ui.js';
import { vitrine } from '../vitrine.js';

export default function login(alvo, aoEntrar) {
  document.title = 'Entrar · Banqueiro PAY AX';
  alvo.innerHTML = String(html`
    <div class="login">
      <section class="lado">
        <div id="vitrine"></div>
        <div class="rodape-lado">© ${new Date().getFullYear()} PAY AX · Uso exclusivo da equipe</div>
      </section>
      <section class="form-lado">
        <form id="form-login" novalidate>
          <img src="img/logo-payax.svg" alt="PAY AX" style="height:44px;margin-bottom:8px">
          <div class="cabecalho-acesso"><h1>Acessar o Banqueiro</h1><p class="muted" style="margin:4px 0 8px">Entre com suas credenciais corporativas.</p></div>
          <div class="erro-form hidden" id="erro"></div>
          <div><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required></div>
          <div><label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required></div>
          <button class="btn primario" type="submit">Entrar</button>
          ${window.PAYAX_DEMO ? html`<div class="card card-body small" style="background:var(--info-bg);border:0;box-shadow:none">
            <strong>Demonstração.</strong> Dados fictícios salvos só no seu navegador.<br>
            Admin: <span class="mono">admin@payax.com.br</span> / <span class="mono">admin123</span><br>
            Gerente ou operador: <span class="mono">gerente@payax.com.br</span> · <span class="mono">operador@payax.com.br</span> / <span class="mono">payax2026</span></div>` : ''}
          <p class="small muted" style="margin:0">Acesso restrito a colaboradores autorizados. Todas as ações são registradas em auditoria.</p>
        </form>
      </section>
    </div>`);
  vitrine($('#vitrine', alvo), { raizImg: 'img/' });
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
