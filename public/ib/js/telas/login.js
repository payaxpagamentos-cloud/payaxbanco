import { api, sessao } from '../api.js';
import { html, $, mascaraDocumento } from '../../../js/ui.js';

export function telaLogin(alvo, aoEntrar, aviso) {
  document.title = 'Entrar · Internet Banking PAY AX';
  alvo.innerHTML = String(html`
    <div class="login">
      <section class="lado">
        <img src="../img/logo-payax-branco.svg" alt="PAY AX" style="height:52px;align-self:flex-start">
        <div style="position:relative;z-index:1">
          <h2>Seu dinheiro, <span>na palma da mão.</span></h2>
          <p>Consulte o saldo, faça PIX, pague contas e acompanhe tudo pelo Internet Banking PAY AX.</p>
        </div>
        <div class="small" style="color:#7F93B8;position:relative;z-index:1">© ${new Date().getFullYear()} PAY AX</div>
      </section>
      <section class="form-lado">
        <form id="form-login" novalidate>
          <img src="../img/logo-payax.svg" alt="PAY AX" style="height:44px;margin-bottom:8px">
          <div><h1>Internet Banking</h1><p class="muted" style="margin:4px 0 8px">Acesse com seu CPF ou CNPJ.</p></div>
          <div class="erro-form ${aviso ? '' : 'hidden'}" id="erro">${aviso ?? ''}</div>
          <div><label for="documento">CPF ou CNPJ</label><input id="documento" name="documento" inputmode="numeric" autocomplete="username" required></div>
          <div><label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required></div>
          <button class="btn primario" type="submit">Entrar</button>
          ${window.PAYAX_DEMO ? html`<div class="card card-body small" style="background:var(--info-bg);border:0;box-shadow:none">
            <strong>Demonstração.</strong> CPF <span class="mono">529.982.247-25</span> / <span class="mono">Cliente2026</span><br>
            ou CNPJ <span class="mono">11.222.333/0001-81</span> / <span class="mono">Empresa2026</span><br>Senha de transação: <span class="mono">246810</span></div>` : ''}
          <p class="small muted" style="margin:0">Primeiro acesso? Use a senha provisória entregue pela PAY AX. Nunca informe sua senha por telefone, e-mail ou mensagem.</p>
        </form>
      </section>
    </div>`);
  const form = $('#form-login', alvo);
  mascaraDocumento($('#documento', alvo));
  setTimeout(() => $('#documento', alvo).focus(), 0);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', alvo);
    const botao = $('button', form);
    botao.disabled = true;
    erro.classList.add('hidden');
    try {
      const r = await api.post('/auth/login', { documento: form.documento.value, senha: form.senha.value });
      sessao.set({ token: r.token });
      aoEntrar(r);
    } catch (err) {
      erro.textContent = err.message;
      erro.classList.remove('hidden');
      botao.disabled = false;
    }
  });
}

export function telaPrimeiroAcesso(alvo, nome, aoConcluir, aoSair) {
  document.title = 'Primeiro acesso · Internet Banking PAY AX';
  alvo.innerHTML = String(html`
    <div style="min-height:100vh;display:grid;place-items:center;padding:24px 16px">
      <form id="form-pa" class="card card-body stack" style="width:min(440px,100%)" novalidate>
        <img src="../img/logo-payax.svg" alt="PAY AX" style="height:36px;align-self:flex-start">
        <div><h1>Bem-vindo(a), ${nome.split(' ')[0]}!</h1><p class="muted" style="margin:4px 0 0">Para sua segurança, crie sua senha de acesso e sua senha de transação.</p></div>
        <div class="erro-form hidden" id="erro"></div>
        <div><label for="nova">Nova senha de acesso</label><input id="nova" name="nova" type="password" autocomplete="new-password" required>
          <div class="ajuda">Mínimo de 8 caracteres, com letras e números.</div></div>
        <div><label for="conf">Confirme a senha</label><input id="conf" name="conf" type="password" autocomplete="new-password" required></div>
        <div><label for="pin">Senha de transação (6 dígitos)</label><input id="pin" name="pin" type="password" inputmode="numeric" maxlength="6" class="pin" required>
          <div class="ajuda">Usada para confirmar PIX, transferências e pagamentos. Evite datas e sequências.</div></div>
        <div><label for="pin2">Confirme a senha de transação</label><input id="pin2" name="pin2" type="password" inputmode="numeric" maxlength="6" class="pin" required></div>
        <button class="btn primario" type="submit" style="height:42px">Salvar e continuar</button>
        <button class="btn link" type="button" id="sair">Sair</button>
      </form>
    </div>`);
  const form = $('#form-pa', alvo);
  $('#sair', alvo).onclick = aoSair;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', alvo);
    erro.classList.add('hidden');
    try {
      if (form.nova.value !== form.conf.value) throw new Error('As senhas de acesso não conferem.');
      if (form.pin.value !== form.pin2.value) throw new Error('As senhas de transação não conferem.');
      await api.post('/auth/primeiro-acesso', { nova_senha: form.nova.value, pin: form.pin.value });
      aoConcluir();
    } catch (err) {
      erro.textContent = err.message;
      erro.classList.remove('hidden');
    }
  });
}
