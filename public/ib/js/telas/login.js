import { api, sessao } from '../api.js';
import { html, $, mascaraDocumento, marca, icone } from '../../../js/ui.js';
import { tecladoPares, criarSenhaNova } from '../teclado.js';
import { vitrine } from '../../../js/vitrine.js';
import { RAIZ, SITE } from '../raiz.js';
import { abrirConta, acompanharProposta } from './abertura.js';

const PRODUTOS = [
  { icone: 'pix', titulo: 'PIX 24 horas', texto: 'Envie e receba na hora, para qualquer banco, com QR Code e chaves.' },
  { icone: 'barras', titulo: 'Pague suas contas', texto: 'Boletos, água, luz e telefone com comprovante na hora.' },
  { icone: 'emprestimos', titulo: 'Crédito', texto: 'Empréstimos com parcelas fixas. Fale com seu gerente.' },
  { icone: 'contas', titulo: 'Conta para empresas', texto: 'Receba de clientes e acompanhe tudo em tempo real.' },
];

/** Tela de acesso no padrão dos grandes bancos: cabeçalho, banner de campanhas e caixa de acesso em duas etapas. */
export function telaLogin(alvo, aoEntrar, aviso) {
  document.title = 'Internet Banking · PAY AX';
  alvo.innerHTML = String(html`
    <div class="site">
      <header class="site-topo">
        <div class="site-linha">
          ${SITE ? html`<a href="${SITE}" class="marca-link" title="Ir para o site da PAY AX">${marca('clara')}</a>` : marca('clara')}
          <nav class="site-nav" aria-label="Seções">
            <button type="button" data-rolar="produtos">Para você</button>
            <button type="button" data-rolar="produtos">Para empresas</button>
            <button type="button" data-rolar="produtos">PIX</button>
            <button type="button" data-rolar="produtos">Crédito</button>
            <button type="button" data-rolar="seguranca">Segurança</button>
          </nav>
          <span class="site-cadeado">${icone('auditoria')} Ambiente seguro</span>
          <button type="button" class="btn link site-acompanhar" id="acompanhar">Acompanhe sua proposta</button>
          <button type="button" class="btn ouro" id="abrir-conta">Abra sua conta</button>
        </div>
      </header>

      <section class="site-hero">
        <div id="vitrine" class="hero-vitrine"></div>
        <div class="site-linha hero-linha">
          <div class="caixa-acesso" id="caixa">
            <h1>Acesse sua conta</h1>
            <div class="abas-acesso" role="tablist">
              <button type="button" role="tab" class="ativa" data-tipo="PF">Pessoa física</button>
              <button type="button" role="tab" data-tipo="PJ">Empresa</button>
            </div>
            <div class="erro-form ${aviso ? '' : 'hidden'}" id="erro">${aviso ?? ''}</div>
            <form id="passo-documento" novalidate>
              <label for="documento" id="rotulo-doc">CPF</label>
              <input id="documento" name="documento" inputmode="numeric" autocomplete="username" placeholder="000.000.000-00" required>
              <button class="btn primario" type="submit">Continuar</button>
              <p class="dica">Primeiro acesso? Use a senha provisória entregue pela PAY AX.</p>
            </form>
            <form id="passo-senha" novalidate hidden>
              <div class="quem"><span>Olá! <strong id="doc-mascarado"></strong></span><button type="button" class="btn link" id="trocar">Trocar</button></div>
              <div id="teclado-login"></div>
              <button class="btn primario" type="submit" id="entrar" disabled>Entrar</button>
            </form>
            <div class="sem-conta">Ainda não é cliente? <button type="button" class="btn link" id="abrir-conta-2">Abra sua conta</button></div>
            ${window.PAYAX_DEMO ? html`<div class="dica-demo"><strong>Demo:</strong> CPF 529.982.247-25 · senha 135790 · transação 246810</div>` : ''}
          </div>
        </div>
      </section>

      <section class="site-produtos" id="produtos">
        <div class="site-linha">
          <div class="row" style="justify-content:space-between;margin-bottom:18px"><h2 style="margin:0">Tudo o que você precisa, no computador</h2>
            <button type="button" class="btn primario" id="abrir-conta-3">Abra sua conta grátis</button></div>
          <div class="produtos">${PRODUTOS.map((p) => html`<div class="produto-card"><span class="ic">${icone(p.icone)}</span><h3>${p.titulo}</h3><p>${p.texto}</p></div>`)}</div>
        </div>
      </section>

      <section class="site-aviso" id="seguranca">
        <div class="site-linha">
          <span class="ic">${icone('auditoria')}</span>
          <div><strong>A PAY AX nunca pede sua senha</strong> por telefone, e-mail, SMS ou mensagem. Digite suas senhas somente no
            teclado virtual desta página, cujos números mudam de posição a cada acesso.</div>
        </div>
      </section>

      <footer class="site-rodape">
        <div class="site-linha">
          <div>${marca('escura')}<p>O futuro em cada transação.</p></div>
          <div><h4>Produtos</h4><p>Conta digital · PIX · Pagamentos · Crédito</p></div>
          <div><h4>Segurança</h4><p>Teclado virtual · Senha de transação · Limite diário</p></div>
          <div><h4>Institucional</h4><p>© ${new Date().getFullYear()} PAY AX. Todos os direitos reservados.</p></div>
        </div>
      </footer>
    </div>`);

  vitrine($('#vitrine', alvo), { raizImg: `${RAIZ}img/`, modo: 'hero' });
  alvo.querySelectorAll('[data-rolar]').forEach((b) => b.addEventListener('click', () => $(`#${b.dataset.rolar}`, alvo).scrollIntoView({ behavior: 'smooth' })));

  ['#abrir-conta', '#abrir-conta-2', '#abrir-conta-3'].forEach((id) => { $(id, alvo).onclick = abrirConta; });
  $('#acompanhar', alvo).onclick = acompanharProposta;

  const erro = $('#erro', alvo);
  const mostrarErro = (msg) => { erro.textContent = msg; erro.classList.remove('hidden'); };
  const docInput = $('#documento', alvo);
  mascaraDocumento(docInput);
  let tipo = 'PF';
  alvo.querySelectorAll('[data-tipo]').forEach((b) => b.addEventListener('click', () => {
    tipo = b.dataset.tipo;
    alvo.querySelectorAll('[data-tipo]').forEach((x) => x.classList.toggle('ativa', x === b));
    $('#rotulo-doc', alvo).textContent = tipo === 'PF' ? 'CPF' : 'CNPJ';
    docInput.placeholder = tipo === 'PF' ? '000.000.000-00' : '00.000.000/0000-00';
    docInput.value = '';
    docInput.focus();
  }));

  const passoDoc = $('#passo-documento', alvo);
  const passoSenha = $('#passo-senha', alvo);
  const botao = $('#entrar', alvo);
  let teclado = null;
  setTimeout(() => docInput.focus(), 0);

  passoDoc.addEventListener('submit', (e) => {
    e.preventDefault();
    erro.classList.add('hidden');
    const d = docInput.value.replace(/\D/g, '');
    if (d.length !== (tipo === 'PF' ? 11 : 14)) return mostrarErro(tipo === 'PF' ? 'Informe os 11 números do CPF.' : 'Informe os 14 números do CNPJ.');
    $('#doc-mascarado', alvo).textContent = d.length === 11
      ? `CPF ***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`
      : `CNPJ ${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-**`;
    passoDoc.hidden = true;
    passoSenha.hidden = false;
    alvo.querySelector('.abas-acesso').hidden = true;
    teclado = tecladoPares($('#teclado-login', alvo), { rotulo: 'Senha de acesso (6 números)', aoMudar: (ok) => { botao.disabled = !ok; } });
  });

  $('#trocar', alvo).onclick = () => {
    passoSenha.hidden = true;
    passoDoc.hidden = false;
    alvo.querySelector('.abas-acesso').hidden = false;
    erro.classList.add('hidden');
    docInput.focus();
  };

  passoSenha.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!teclado?.completo()) return;
    botao.disabled = true;
    erro.classList.add('hidden');
    try {
      const r = await api.post('/auth/login', { documento: docInput.value, ...teclado.valor() });
      sessao.set({ token: r.token });
      aoEntrar(r);
    } catch (err) {
      mostrarErro(err.message);
      teclado.renovar();
    }
  });

  // Vindo da caixa "Acesse sua conta" do site institucional: segue direto para a senha.
  let doSite = null;
  try { doSite = sessionStorage.getItem('payax.site.documento'); sessionStorage.removeItem('payax.site.documento'); } catch { /* ignora */ }
  if (doSite && /^(\d{11}|\d{14})$/.test(doSite)) {
    if (doSite.length === 14) alvo.querySelector('[data-tipo="PJ"]').click();
    docInput.value = doSite;
    docInput.dispatchEvent(new Event('input'));
    passoDoc.requestSubmit();
  }
}

export async function telaPrimeiroAcesso(alvo, nome, aoConcluir, aoSair) {
  document.title = 'Primeiro acesso · Internet Banking PAY AX';
  alvo.innerHTML = String(html`
    <div class="login">
      <div class="card card-body stack" style="width:min(420px,100%);border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.45)">
        <div style="align-self:center">${marca('clara')}</div>
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
