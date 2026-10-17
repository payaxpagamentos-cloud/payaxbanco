import { api, sessao, BASE, enderecos } from '../api.js';
import { html, $, marca, icone } from '../ui.js';
import { globo } from '../globo.js';

/**
 * Página de login da Ativa BPO Financeiro (equipe e Portal do Cliente): painel da marca à esquerda e
 * formulário à direita; com 2FA ativa, pede o código do aplicativo numa segunda etapa.
 */
export function telaEntrada(alvo, { titulo, selo, linha1, destaque, descricao, rota, rota2fa, aoEntrar, aviso, troca, tituloPagina }) {
  document.title = tituloPagina;
  alvo.innerHTML = String(html`<div class="entrada">
    <div class="entrada-fundo" aria-hidden="true"></div>
    <section class="entrada-marca">
      <span class="entrada-selo"><i></i>${selo}</span>
      <h2>${linha1} <span class="grad">${destaque}</span></h2>
      <p>${descricao}</p>
    </section>
    <canvas class="entrada-globo" aria-hidden="true"></canvas>
    <section class="entrada-form"><div class="entrada-caixa" id="caixa"></div></section>
    <div class="entrada-rodape">© ${new Date().getFullYear()} Ativa BPO Financeiro</div></div>`);
  globo($('.entrada-globo', alvo));
  const caixa = $('#caixa', alvo);
  const cabecalho = (t) => html`<div class="entrada-logo">${marca('clara')}</div>
    <div class="entrada-titulo"><h1>${t}</h1><span class="cadeado">${icone('cadeado')}</span></div>`;

  const passoSenha = () => {
    caixa.innerHTML = String(html`${cabecalho(titulo)}
      <form id="form-entrada" novalidate>
        <div class="erro-form hidden" id="erro"></div>
        <label class="campo">${icone('email')}<input id="email" name="email" type="email" autocomplete="username" required placeholder="E-mail" aria-label="E-mail"></label>
        <label class="campo">${icone('cadeado')}<input id="senha" name="senha" type="password" autocomplete="current-password" required placeholder="Senha" aria-label="Senha">
          <button type="button" id="ver-senha" aria-label="Mostrar senha" title="Mostrar senha">${icone('olho')}</button></label>
        <button class="btn-entrar" type="submit">Entrar ${icone('entrar')}</button>
      </form>
      <div class="entrada-aviso">${icone('cadeado')}<span>${aviso}</span></div>
      ${troca ? html`<div class="entrada-troca">${troca}</div>` : ''}`);
    const form = $('#form-entrada', caixa);
    setTimeout(() => form.email.focus());
    // Link para o outro acesso (equipe ↔ Portal), no endereço configurado no servidor.
    const link = $('[data-endereco]', caixa);
    if (link) enderecos().then((e) => { link.href = e[link.dataset.endereco]; });
    $('#ver-senha', caixa).addEventListener('click', (e) => {
      const visivel = form.senha.type === 'text';
      form.senha.type = visivel ? 'password' : 'text';
      e.currentTarget.innerHTML = String(icone(visivel ? 'olho' : 'olhoFechado'));
      e.currentTarget.setAttribute('aria-label', visivel ? 'Mostrar senha' : 'Ocultar senha');
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = $('button[type=submit]', form);
      botao.disabled = true;
      try {
        const r = await api.post(rota, { email: form.email.value, senha: form.senha.value });
        if (r.precisa_2fa) return passoCodigo(r.desafio);
        sessao.set(r);
        aoEntrar();
      } catch (err) {
        erro(err.message);
        botao.disabled = false;
      }
    });
  };

  const passoCodigo = (desafio) => {
    caixa.innerHTML = String(html`${cabecalho('Verificação em duas etapas')}
      <p class="entrada-sub">Digite o código de 6 dígitos do seu aplicativo autenticador.</p>
      <form id="form-codigo" novalidate><div class="erro-form hidden" id="erro"></div>
        <label class="campo"><input class="codigo" name="codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="000000" aria-label="Código"></label>
        <button class="btn-entrar" type="submit">Confirmar ${icone('entrar')}</button></form>
      <div class="entrada-troca"><a href="#" id="voltar">Voltar</a> · Perdeu o celular? Peça para redefinir a verificação.</div>`);
    const form = $('#form-codigo', caixa);
    form.codigo.focus();
    $('#voltar', caixa).addEventListener('click', (e) => { e.preventDefault(); passoSenha(); });
    form.codigo.addEventListener('input', () => { if (/^\d{6}$/.test(form.codigo.value)) form.requestSubmit(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        sessao.set(await api.post(rota2fa, { desafio, codigo: form.codigo.value }));
        aoEntrar();
      } catch (err) {
        erro(err.message);
        form.codigo.value = '';
        form.codigo.focus();
        if (/Tempo esgotado/.test(err.message)) setTimeout(passoSenha, 1500);
      }
    });
  };

  const erro = (msg) => { const el = $('#erro', caixa); el.textContent = msg; el.classList.remove('hidden'); };
  passoSenha();
}
