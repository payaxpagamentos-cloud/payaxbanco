import { api, sessao } from '../api.js';
import { html, raw, $, mascaraDocumento, marca, icone } from '../../../js/ui.js';
import { tecladoPares, criarSenhaNova } from '../teclado.js';
import { SITE } from '../raiz.js';
import { abrirConta, acompanharProposta } from './abertura.js';

const RECURSOS = [
  { icone: 'barras', titulo: 'Pague suas contas', texto: 'Boletos, água, luz e telefone com comprovante na hora.' },
  { icone: 'operacoes', titulo: 'Transferências', texto: 'Entre contas PAY AX, na hora.' },
  { icone: 'transacoes', titulo: 'Extrato e comprovantes', texto: 'Entradas e saídas por período.' },
  { icone: 'emprestimos', titulo: 'Empréstimos', texto: 'Acompanhe parcelas e vencimentos.' },
];
// Site em outro endereço (ex.: demonstração publicada): abre em nova aba.
const alvoSite = raw(SITE && /^https?:/.test(SITE) ? 'target="_blank" rel="noopener"' : '');

/** Tela de acesso no padrão dos grandes bancos: cabeçalho, banner de campanhas e caixa de acesso em duas etapas. */
export function telaLogin(alvo, aoEntrar, aviso) {
  document.title = 'Internet Banking · PAY AX';
  alvo.innerHTML = String(html`
    <div class="acesso">
      <header class="acesso-topo">
        <div class="acesso-linha">
          ${SITE ? html`<a href="${SITE}" ${alvoSite} class="marca-link" title="Ir para o site da PAY AX">${marca('clara')}</a>` : marca('clara')}
          <span class="acesso-produto">Internet Banking</span>
          <nav class="acesso-nav" aria-label="Seções">
            <button type="button" data-rolar="recursos">Recursos</button>
            <button type="button" data-rolar="seguranca">Segurança</button>
            ${SITE ? html`<a href="${SITE}" ${alvoSite}>Site PAY AX</a>` : ''}
          </nav>
          <button type="button" class="btn link acesso-acompanhar" id="acompanhar">Acompanhe sua proposta</button>
          <button type="button" class="btn pilula gradiente" id="abrir-conta">Abra sua conta</button>
        </div>
      </header>

      <section class="acesso-hero">
        <div class="feixe f1" aria-hidden="true"></div><div class="feixe f2" aria-hidden="true"></div><div class="feixe f3" aria-hidden="true"></div>
        <div class="acesso-linha acesso-grade">
          <div class="acesso-chamada">
            <span class="sobretitulo">Internet Banking PAY AX</span>
            <h2>Sua conta PAY AX, <span class="grad">sempre à mão.</span></h2>
            <p>Consulte saldo e extrato, faça PIX, transferências e pagamentos com segurança em cada operação.</p>
            <div class="pilulas"><span class="pilula-info"><i></i>PIX 24 horas</span><span class="pilula-info"><i></i>Teclado virtual</span><span class="pilula-info"><i></i>Senha de transação</span></div>
          </div>
          <div class="acesso-palco">
            <div class="anel tracejado" aria-hidden="true"></div><div class="anel" aria-hidden="true"></div>
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
                <button class="btn pilula gradiente" type="submit">Continuar</button>
                <p class="dica">Primeiro acesso? Use a senha provisória entregue pela PAY AX.</p>
              </form>
              <form id="passo-senha" novalidate hidden>
                <div class="quem"><span>Olá! <strong id="doc-mascarado"></strong></span><button type="button" class="btn link" id="trocar">Trocar</button></div>
                <div id="teclado-login"></div>
                <button class="btn pilula gradiente" type="submit" id="entrar" disabled>Entrar</button>
              </form>
              <div class="sem-conta">Ainda não é cliente? <button type="button" class="btn link" id="abrir-conta-2">Abra sua conta</button></div>
              ${window.PAYAX_DEMO ? html`<div class="dica-demo"><strong>Demo:</strong> CPF 529.982.247-25 · senha 135790 · transação 246810</div>` : ''}
            </div>
          </div>
        </div>
      </section>

      <section class="acesso-secao" id="recursos">
        <div class="acesso-linha">
          <div class="acesso-cab"><span class="sobretitulo">Recursos</span><h2>Tudo o que você precisa, <span class="grad">no computador.</span></h2></div>
          <div class="bento">
            <div class="ladrilho l-4 destaque"><span class="deco" aria-hidden="true"></span><span class="ic">${icone('pix')}</span><h3>PIX 24 horas</h3>
              <p>Envie por chave, receba por QR Code e confira o nome de quem vai receber antes de confirmar.</p></div>
            ${RECURSOS.map((p) => html`<div class="ladrilho l-2"><span class="ic">${icone(p.icone)}</span><h3>${p.titulo}</h3><p>${p.texto}</p></div>`)}
            <div class="ladrilho l-4"><span class="ic">${icone('contas')}</span><h3>Conta para empresas</h3><p>Receba de clientes por PIX e acompanhe cada entrada e saída em tempo real.</p></div>
            <button type="button" class="ladrilho l-2 ladrilho-cta" id="abrir-conta-3"><span class="ic">${icone('mais')}</span><h3>Abra sua conta</h3><p>Pela internet, em 4 passos.</p><span class="vai">Começar →</span></button>
          </div>
        </div>
      </section>

      <section class="acesso-secao acesso-seguranca" id="seguranca">
        <div class="acesso-linha">
          <div class="acesso-cab"><span class="sobretitulo">Segurança</span><h2>Sua senha protegida <span class="grad">em cada acesso.</span></h2></div>
          <div class="seg-grade">
            <div><h3>Teclado virtual</h3><p>Cada botão mostra dois números, que mudam de posição a cada acesso.</p></div>
            <div><h3>Duas senhas</h3><p>Uma para entrar e outra, diferente, para confirmar cada saída de dinheiro.</p></div>
            <div><h3>Limite diário</h3><p>PIX, transferências e pagamentos têm limite por dia.</p></div>
            <div><h3>Nunca pedimos sua senha</h3><p>A PAY AX não pede senha por telefone, e-mail, SMS ou mensagem.</p></div>
          </div>
        </div>
      </section>

      <footer class="acesso-rodape">
        <div class="acesso-linha">
          <div>${marca('clara')}<div class="slogan">O futuro em cada transação.</div></div>
          <span>© ${new Date().getFullYear()} PAY AX. Todos os direitos reservados.</span>
        </div>
      </footer>
    </div>`);

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
