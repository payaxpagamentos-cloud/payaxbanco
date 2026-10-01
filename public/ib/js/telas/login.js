import { api, sessao } from '../api.js';
import { html, $, mascaraDocumento } from '../../../js/ui.js';
import { tecladoPares, criarSenhaNova } from '../teclado.js';

export function telaLogin(alvo, aoEntrar, aviso) {
  document.title = 'Entrar · Internet Banking PAY AX';
  alvo.innerHTML = String(html`
    <div class="login">
      <section class="lado">
        <img class="arte" src="../img/payax-marca.jpg" alt="PAY AX — O futuro em cada transação.">
        <div>
          <h2>Internet Banking <span>PAY AX</span></h2>
          <p>Consulte saldo e extrato, faça PIX, transferências e pagamentos com segurança.</p>
        </div>
        <div class="small" style="color:#7F93B8">© ${new Date().getFullYear()} PAY AX</div>
      </section>
      <section class="form-lado">
        <form id="form-login" novalidate>
          <img src="../img/logo-payax.svg" alt="PAY AX" style="height:44px;margin-bottom:8px">
          <div><h1>Internet Banking</h1><p class="muted" style="margin:4px 0 8px">Acesse com seu CPF ou CNPJ.</p></div>
          <div class="erro-form ${aviso ? '' : 'hidden'}" id="erro">${aviso ?? ''}</div>
          <div><label for="documento">CPF ou CNPJ</label><input id="documento" name="documento" inputmode="numeric" autocomplete="username" required></div>
          <div id="teclado-login"></div>
          <button class="btn primario" type="submit" id="entrar" disabled>Entrar</button>
          ${window.PAYAX_DEMO ? html`<div class="card card-body small" style="background:var(--info-bg);border:0;box-shadow:none">
            <strong>Demonstração.</strong> CPF <span class="mono">529.982.247-25</span> · senha <span class="mono">135790</span><br>
            ou CNPJ <span class="mono">11.222.333/0001-81</span> · senha <span class="mono">975310</span><br>Senha de transação: <span class="mono">246810</span></div>` : ''}
          <p class="small muted" style="margin:0">Clique no botão que contém cada número da sua senha; a posição dos números muda a cada acesso. Primeiro acesso? Use a senha provisória entregue pela PAY AX. Nunca informe sua senha por telefone, e-mail ou mensagem.</p>
        </form>
      </section>
    </div>`);
  const form = $('#form-login', alvo);
  const botao = $('#entrar', alvo);
  const teclado = tecladoPares($('#teclado-login', alvo), { rotulo: 'Senha de acesso (6 números)', aoMudar: (ok) => { botao.disabled = !ok; } });
  mascaraDocumento($('#documento', alvo));
  setTimeout(() => $('#documento', alvo).focus(), 0);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', alvo);
    if (!teclado.completo()) return;
    botao.disabled = true;
    erro.classList.add('hidden');
    try {
      const r = await api.post('/auth/login', { documento: form.documento.value, ...teclado.valor() });
      sessao.set({ token: r.token });
      aoEntrar(r);
    } catch (err) {
      erro.textContent = err.message;
      erro.classList.remove('hidden');
      teclado.renovar();
    }
  });
}

export async function telaPrimeiroAcesso(alvo, nome, aoConcluir, aoSair) {
  document.title = 'Primeiro acesso · Internet Banking PAY AX';
  alvo.innerHTML = String(html`
    <div style="min-height:100vh;display:grid;place-items:center;padding:24px 16px">
      <div class="card card-body stack" style="width:min(420px,100%)">
        <img src="../img/logo-payax.svg" alt="PAY AX" style="height:36px;align-self:flex-start">
        <div><h1>Bem-vindo(a), ${nome.split(' ')[0]}!</h1><p class="muted" style="margin:4px 0 0">Para sua segurança, crie suas senhas. São duas senhas diferentes, de 6 números cada.</p></div>
        <div class="passos"><span class="feito" id="p1"></span><span id="p2"></span></div>
        <div class="erro-form hidden" id="erro"></div>
        <div id="etapa"></div>
        <button class="btn link" type="button" id="sair">Sair</button>
      </div>
    </div>`);
  $('#sair', alvo).onclick = aoSair;
  const etapa = $('#etapa', alvo);
  for (;;) {
    const senha = await criarSenhaNova(etapa, { rotulo: 'senha de acesso', ajuda: 'Usada para entrar no Internet Banking. Evite datas, sequências e repetições.' });
    $('#p2', alvo).classList.add('feito');
    const pin = await criarSenhaNova(etapa, { rotulo: 'senha de transação', ajuda: 'Usada para confirmar PIX, transferências e pagamentos. Deve ser diferente da senha de acesso.' });
    etapa.innerHTML = '<div class="carregando">Salvando…</div>';
    try {
      await api.post('/auth/primeiro-acesso', { nova_senha: senha, pin });
      aoConcluir();
      return;
    } catch (err) {
      const erro = $('#erro', alvo);
      erro.textContent = err.message;
      erro.classList.remove('hidden');
      $('#p2', alvo).classList.remove('feito');
    }
  }
}
