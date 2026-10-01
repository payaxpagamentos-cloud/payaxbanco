import { api, sessao } from '../api.js';
import { html, $, marca } from '../ui.js';
import { vitrine } from '../vitrine.js';

export default function login(alvo, aoEntrar) {
  document.title = 'Entrar · Banqueiro PAY AX';
  alvo.innerHTML = String(html`
    <div class="login">
      <div class="login-cartao">
        <section class="lado" aria-label="Novidades PAY AX"><div id="vitrine"></div></section>
        <section class="form-lado">
        <form id="form-login" novalidate>
          <div style="align-self:center">${marca('clara')}</div>
          <div class="cabecalho-acesso"><h1>Acessar o Banqueiro</h1><p class="muted" style="margin:2px 0 4px">Entre com suas credenciais corporativas.</p></div>
          <div class="erro-form hidden" id="erro"></div>
          <div><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required></div>
          <div><label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required></div>
          <button class="btn primario" type="submit">Entrar</button>
          ${window.PAYAX_DEMO ? html`<div class="card small" style="background:var(--info-bg);border:0;box-shadow:none;padding:10px 12px">
            <strong>Demo:</strong> <span class="mono">admin@payax.com.br</span> / <span class="mono">admin123</span><br>
            Gerente ou operador: <span class="mono">gerente@</span> ou <span class="mono">operador@payax.com.br</span> / <span class="mono">payax2026</span></div>` : ''}
          <p class="dica">Acesso restrito a colaboradores autorizados. Ações registradas em auditoria.</p>
        </form>
        </section>
      </div>
      <div class="login-rodape">© ${new Date().getFullYear()} PAY AX · Uso exclusivo da equipe</div>
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
