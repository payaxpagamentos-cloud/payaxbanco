import { api, sessao } from '../api.js';
import { html, $, mascaraDocumento } from '../../../js/ui.js';
import { tecladoPares, criarSenhaNova } from '../teclado.js';
import { vitrine } from '../../../js/vitrine.js';
import { RAIZ } from '../raiz.js';

export function telaLogin(alvo, aoEntrar, aviso) {
  document.title = 'Entrar · Internet Banking PAY AX';
  alvo.innerHTML = String(html`
    <div class="login">
      <div class="login-cartao">
        <section class="lado" aria-label="Novidades PAY AX"><div id="vitrine"></div></section>
        <section class="form-lado">
        <form id="form-login" novalidate>
          <img src="${RAIZ}img/logo-payax.svg" alt="PAY AX" style="height:34px;margin-bottom:4px">
          <div class="cabecalho-acesso"><h1>Internet Banking</h1><p class="muted" style="margin:2px 0 4px">Acesse com seu CPF ou CNPJ.</p></div>
          <div class="erro-form ${aviso ? '' : 'hidden'}" id="erro">${aviso ?? ''}</div>
          <div><label for="documento">CPF ou CNPJ</label><input id="documento" name="documento" inputmode="numeric" autocomplete="username" required></div>
          <div id="teclado-login"></div>
          <button class="btn primario" type="submit" id="entrar" disabled>Entrar</button>
          ${window.PAYAX_DEMO ? html`<div class="card small" style="background:var(--info-bg);border:0;box-shadow:none;padding:10px 12px">
            <strong>Demo:</strong> CPF <span class="mono">529.982.247-25</span> · senha <span class="mono">135790</span> · transação <span class="mono">246810</span></div>` : ''}
          <p class="dica">Clique no botão com cada número da senha; as posições mudam a cada acesso.</p>
        </form>
        </section>
      </div>
      <div class="login-rodape">© ${new Date().getFullYear()} PAY AX · Nunca informe sua senha por telefone, e-mail ou mensagem.</div>
    </div>`);
  vitrine($('#vitrine', alvo), { raizImg: `${RAIZ}img/` });
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
    <div class="login">
      <div class="card card-body stack" style="width:min(420px,100%);border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.45)">
        <img src="${RAIZ}img/logo-payax.svg" alt="PAY AX" style="height:36px;align-self:center">
        <div style="text-align:center"><h1>Bem-vindo(a), ${nome.split(' ')[0]}!</h1><p class="muted" style="margin:4px 0 0">Para sua segurança, crie suas senhas. São duas senhas diferentes, de 6 números cada.</p></div>
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
