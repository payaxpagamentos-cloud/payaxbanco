import { api, sessao } from '../api.js';
import { html, $, marca, icone } from '../ui.js';

/**
 * Página de login da Ativa BPO Financeiro (equipe e Portal do Cliente): painel da marca à esquerda e
 * formulário à direita; com 2FA ativa, pede o código do aplicativo numa segunda etapa.
 */
export function telaEntrada(alvo, { titulo, subtitulo, chamada, texto, itens, rota, rota2fa, aoEntrar, aviso, troca, tituloPagina }) {
  document.title = tituloPagina;
  alvo.innerHTML = String(html`<div class="entrada">
    <section class="entrada-marca" aria-label="Ativa BPO Financeiro">
      <img class="entrada-logo" src="/img/ativa-logo.png" alt="Ativa BPO Financeiro">
      <div class="entrada-chamada"><span class="sobre">${chamada}</span><h2>${texto}</h2>
        <ul class="entrada-lista">${itens.map(([ic, t]) => html`<li><span>${icone(ic)}</span>${t}</li>`)}</ul></div>
      <div class="entrada-rodape">© ${new Date().getFullYear()} Ativa BPO Financeiro</div>
    </section>
    <section class="entrada-form"><div class="entrada-caixa" id="caixa"></div></section></div>`);
  const caixa = $('#caixa', alvo);

  const passoSenha = () => {
    caixa.innerHTML = String(html`${marca('clara')}
      <h1>${titulo}</h1><p class="sub">${subtitulo}</p>
      <form id="form-entrada" class="stack" style="gap:14px" novalidate>
        <div class="erro-form hidden" id="erro"></div>
        <div><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required placeholder="voce@empresa.com.br"></div>
        <div><label for="senha">Senha</label><div class="campo-senha"><input id="senha" name="senha" type="password" autocomplete="current-password" required>
          <button type="button" id="ver-senha" aria-label="Mostrar senha" title="Mostrar senha">${icone('olho')}</button></div></div>
        <button class="btn primario" type="submit">Entrar</button>
      </form>
      ${troca ? html`<div class="entrada-troca">${troca}</div>` : ''}
      <div class="entrada-aviso">${icone('escudo')}<span>${aviso}</span></div>`);
    const form = $('#form-entrada', caixa);
    setTimeout(() => form.email.focus());
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
    caixa.innerHTML = String(html`${marca('clara')}
      <h1>Verificação em duas etapas</h1><p class="sub">Digite o código de 6 dígitos do seu aplicativo autenticador.</p>
      <form id="form-codigo" class="stack" style="gap:14px" novalidate><div class="erro-form hidden" id="erro"></div>
        <input class="codigo" name="codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="000000" aria-label="Código">
        <button class="btn primario" type="submit">Confirmar</button></form>
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
