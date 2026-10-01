/*
 * Site institucional da PAY AX (público, sem login): mesmo layout de site de banco do Internet Banking.
 * Páginas por hash (#/voce, #/empresas, ...). O acesso à conta leva ao Internet Banking.
 */
import { html, raw, $, marca, icone, moeda, mascaraDocumento, mascaraMoeda, centavos } from '../../js/ui.js';
import { vitrine } from '../../js/vitrine.js';
import { INSTITUCIONAL as I } from './config.js';

// Caminho até a raiz pública a partir desta página (produção: /site/ → '../'; demo publicada: '').
const RAIZ = window.PAYAX_SITE_RAIZ ?? '../';
const IB = `${RAIZ}ib/index.html`;
const IMG = `${RAIZ}img/`;

const PAGINAS = {
  '': { titulo: 'Início', render: inicio },
  voce: { titulo: 'Para você', render: paraVoce },
  empresas: { titulo: 'Para empresas', render: paraEmpresas },
  credito: { titulo: 'Crédito', render: credito },
  seguranca: { titulo: 'Segurança', render: seguranca },
  sobre: { titulo: 'Sobre a PAY AX', render: sobre },
  ajuda: { titulo: 'Ajuda', render: ajuda },
};
const MENU = ['voce', 'empresas', 'credito', 'seguranca', 'sobre', 'ajuda'];

const app = document.getElementById('app');

function rota() {
  const nome = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0];
  return PAGINAS[nome] ? nome : '';
}

function desenhar() {
  const nome = rota();
  const pagina = PAGINAS[nome];
  document.title = nome ? `${pagina.titulo} · PAY AX` : 'PAY AX · O futuro em cada transação';
  app.innerHTML = String(html`
    <div class="site site-inst">
      ${topo(nome)}
      <main id="conteudo">${pagina.render()}</main>
      ${rodape()}
    </div>`);
  ligar(nome);
  window.scrollTo(0, 0);
}

function topo(atual) {
  return html`
    <header class="site-topo">
      <div class="site-linha">
        <a href="#/" class="marca-link" title="Página inicial">${marca('clara')}</a>
        <nav class="site-nav" aria-label="Seções do site">
          ${MENU.map((m) => html`<a href="#/${m}" class="${m === atual ? 'atual' : ''}" ${m === atual ? raw('aria-current="page"') : ''}>${PAGINAS[m].titulo.replace(' a PAY AX', '')}</a>`)}
        </nav>
        <a class="btn link site-acompanhar" href="${IB}#/acompanhar">Acompanhe sua proposta</a>
        <a class="btn" href="${IB}">Acessar conta</a>
        <a class="btn ouro" href="${IB}#/abrir-conta">Abra sua conta</a>
      </div>
    </header>`;
}

function rodape() {
  return html`
    <footer class="site-rodape site-rodape-inst">
      <div class="site-linha">
        <div>${marca('escura')}<p>${I.slogan}</p>
          <p><a href="${IB}">Acessar o Internet Banking</a></p></div>
        <div><h4>Produtos</h4>
          <p><a href="#/voce">Conta para você</a></p><p><a href="#/empresas">Conta para empresas</a></p>
          <p><a href="#/voce">PIX e pagamentos</a></p><p><a href="#/credito">Crédito</a></p></div>
        <div><h4>Institucional</h4>
          <p><a href="#/sobre">Sobre a PAY AX</a></p><p><a href="#/seguranca">Segurança</a></p>
          <p><a href="#/ajuda">Perguntas frequentes</a></p><p><a href="#/sobre">Tarifas</a></p></div>
        <div><h4>Atendimento</h4>
          <p>Telefone: ${I.atendimento.telefone}</p><p>Horário: ${I.atendimento.horario}</p>
          <p>E-mail: ${I.atendimento.email}</p><p>Ouvidoria: ${I.ouvidoria.telefone}</p></div>
      </div>
      <div class="site-linha site-legal">
        <p>${I.razaoSocial} · CNPJ ${I.cnpj} · ${I.endereco}</p>
        <p>© ${new Date().getFullYear()} PAY AX. Todos os direitos reservados.</p>
      </div>
    </footer>`;
}

// ===== Blocos reutilizáveis =====
const banner = ({ img, espelhar = false, selo, titulo, destaque = '', texto, cor = '#2EE6A6', acoes = true }) => html`
  <section class="site-banner" style="--cor:${cor}">
    <img src="${IMG}${img}" alt="" class="${espelhar ? 'espelhada' : ''}">
    <div class="hero-sombra" aria-hidden="true"></div>
    <div class="site-linha banner-texto">
      <span class="selo">${selo}</span>
      <h1>${titulo}<span class="destaque">${destaque}</span></h1>
      <p>${texto}</p>
      ${acoes ? html`<div class="row"><a class="btn ouro" href="${IB}#/abrir-conta">Abra sua conta</a><a class="btn claro" href="${IB}">Acessar conta</a></div>` : ''}
    </div>
  </section>`;

const cards = (itens) => html`<div class="produtos">${itens.map((p) => html`
  <div class="produto-card"><span class="ic">${icone(p.icone)}</span><h3>${p.titulo}</h3><p>${p.texto}</p></div>`)}</div>`;

const secao = (titulo, sub, corpo, classe = '') => html`
  <section class="site-secao ${classe}">
    <div class="site-linha">
      <div class="secao-cab"><h2>${titulo}</h2>${sub ? html`<p>${sub}</p>` : ''}</div>
      ${corpo}
    </div>
  </section>`;

const chamada = (titulo, texto) => html`
  <section class="site-chamada">
    <div class="site-linha">
      <div><h2>${titulo}</h2><p>${texto}</p></div>
      <a class="btn ouro" href="${IB}#/abrir-conta">Abra sua conta</a>
    </div>
  </section>`;

const PASSOS_ABERTURA = [
  { t: 'Preencha seus dados', d: 'Dados pessoais ou da empresa, contato e endereço, tudo pelo computador.' },
  { t: 'Escolha a conta', d: 'Conta corrente, poupança ou conta de pagamento.' },
  { t: 'Análise da PAY AX', d: 'Nossa equipe confere as informações. Acompanhe pelo protocolo.' },
  { t: 'Primeiro acesso', d: 'Com a conta aprovada, você recebe a senha provisória e cria as suas senhas.' },
];
const passos = () => html`<ol class="passos-site">${PASSOS_ABERTURA.map((p, i) => html`<li><span>${i + 1}</span><h3>${p.t}</h3><p>${p.d}</p></li>`)}</ol>`;

const aviso = () => html`
  <section class="site-aviso">
    <div class="site-linha">
      <span class="ic">${icone('auditoria')}</span>
      <div><strong>A PAY AX nunca pede sua senha</strong> por telefone, e-mail, SMS ou mensagem. Digite suas senhas somente no
        teclado virtual do Internet Banking, cujos números mudam de posição a cada acesso.</div>
    </div>
  </section>`;

// ===== Páginas =====
function inicio() {
  return html`
    <section class="site-hero">
      <div id="vitrine" class="hero-vitrine"></div>
      <div class="site-linha hero-linha">
        <div class="caixa-acesso">
          <h2 class="caixa-titulo">Acesse sua conta</h2>
          <div class="abas-acesso" role="tablist">
            <button type="button" role="tab" class="ativa" data-tipo="PF">Pessoa física</button>
            <button type="button" role="tab" data-tipo="PJ">Empresa</button>
          </div>
          <div class="erro-form hidden" id="erro"></div>
          <form id="form-acesso" novalidate>
            <label for="documento" id="rotulo-doc">CPF</label>
            <input id="documento" inputmode="numeric" autocomplete="username" placeholder="000.000.000-00" required>
            <button class="btn primario" type="submit">Acessar</button>
            <p class="dica">A senha é digitada no teclado virtual, na próxima etapa.</p>
          </form>
          <div class="sem-conta">Ainda não é cliente? <a class="btn link" href="${IB}#/abrir-conta">Abra sua conta</a></div>
        </div>
      </div>
    </section>
    ${secao('Tudo o que você precisa, no computador', 'Uma conta completa para o dia a dia, para você e para a sua empresa.', cards([
      { icone: 'pix', titulo: 'PIX 24 horas', texto: 'Envie e receba na hora, para qualquer banco, com chaves e QR Code.' },
      { icone: 'barras', titulo: 'Pague suas contas', texto: 'Boletos, água, luz e telefone com comprovante na hora.' },
      { icone: 'emprestimos', titulo: 'Crédito', texto: 'Empréstimos com parcelas fixas. Simule e fale com seu gerente.' },
      { icone: 'contas', titulo: 'Conta para empresas', texto: 'Receba de clientes e acompanhe tudo em tempo real.' },
    ]))}
    <section class="site-duplo">
      <div class="site-linha">
        <a class="duplo-card" href="#/voce" style="--fundo:url('${IMG}propagandas/contas-laptop.jpg')">
          <div><span class="selo">Para você</span><h3>Sua vida financeira organizada</h3><p>Saldo, extrato, PIX e pagamentos em um só lugar.</p><span class="mais">Conheça a conta →</span></div>
        </a>
        <a class="duplo-card" href="#/empresas" style="--fundo:url('${IMG}propagandas/empresa-cafe.jpg')">
          <div><span class="selo">Para empresas</span><h3>Seu negócio recebendo melhor</h3><p>Cobranças por PIX e controle de cada movimentação.</p><span class="mais">Conheça a conta PJ →</span></div>
        </a>
      </div>
    </section>
    ${secao('Abra sua conta em 4 passos', 'Todo o processo é feito pela internet.', passos(), 'secao-clara')}
    ${aviso()}
    ${chamada('Venha para a PAY AX', 'Abra sua conta pela internet e acompanhe a análise pelo número do protocolo.')}`;
}

function paraVoce() {
  return html`
    ${banner({ img: 'propagandas/pix-celular-largo.jpg', selo: 'Para você', titulo: 'A conta que cabe ', destaque: 'na sua rotina.', texto: 'Movimente seu dinheiro pelo Internet Banking, com segurança em cada operação.' })}
    ${secao('O que você faz com a conta PAY AX', null, cards([
      { icone: 'pix', titulo: 'PIX', texto: 'Envie por chave, CPF, celular, e-mail ou chave aleatória e receba com QR Code.' },
      { icone: 'operacoes', titulo: 'Transferências', texto: 'Transfira entre contas PAY AX na hora, com comprovante.' },
      { icone: 'barras', titulo: 'Pagamentos', texto: 'Pague boletos bancários e contas de consumo pela linha digitável.' },
      { icone: 'transacoes', titulo: 'Extrato completo', texto: 'Consulte entradas e saídas por período e baixe comprovantes.' },
      { icone: 'perfil', titulo: 'Favorecidos', texto: 'Salve quem você paga com frequência e ganhe tempo.' },
      { icone: 'chave', titulo: 'Senha de transação', texto: 'Cada saída de dinheiro é confirmada com a sua senha de 6 números.' },
      { icone: 'auditoria', titulo: 'Limite diário', texto: 'Um limite diário para PIX, transferências e pagamentos protege a sua conta.' },
      { icone: 'contas', titulo: 'Tipos de conta', texto: 'Conta corrente, poupança ou conta de pagamento: você escolhe na abertura.' },
    ]))}
    ${tarifas()}
    ${secao('Como abrir', null, passos(), 'secao-clara')}
    ${chamada('Abra sua conta PAY AX', 'Leva poucos minutos e é tudo pela internet.')}`;
}

function paraEmpresas() {
  return html`
    ${banner({ img: 'propagandas/empresa-cafe-largo.jpg', espelhar: true, cor: '#FFC83D', selo: 'Para empresas', titulo: 'Seu negócio ', destaque: 'recebendo melhor.', texto: 'Conta PJ com PIX, pagamentos e acompanhamento em tempo real.' })}
    ${secao('Feita para o dia a dia da empresa', null, cards([
      { icone: 'qr', titulo: 'Receba por PIX', texto: 'Gere QR Codes de cobrança e veja o dinheiro entrar na hora.' },
      { icone: 'barras', titulo: 'Pague fornecedores', texto: 'Boletos e transferências com comprovante para a contabilidade.' },
      { icone: 'relatorios', titulo: 'Controle total', texto: 'Extrato detalhado por período para conferir cada lançamento.' },
      { icone: 'clientes', titulo: 'Gerente PAY AX', texto: 'Atendimento de um gerente para crédito e dúvidas da sua empresa.' },
    ]))}
    <section class="site-secao secao-clara">
      <div class="site-linha site-lado">
        <div class="lado-foto"><img src="${IMG}propagandas/credito-escritorio.jpg" alt="Pessoas trabalhando em um escritório"></div>
        <div class="lado-texto">
          <h2>O que você precisa para abrir a conta PJ</h2>
          <ul class="lista-check">
            <li>${icone('check')} CNPJ e razão social da empresa</li>
            <li>${icone('check')} Dados de contato: e-mail e telefone</li>
            <li>${icone('check')} Endereço da empresa</li>
            <li>${icone('check')} Aceite dos termos de abertura</li>
          </ul>
          <p class="muted">A equipe PAY AX analisa a proposta e entra em contato se precisar de algum documento.</p>
          <a class="btn ouro" href="${IB}#/abrir-conta">Abrir conta PJ</a>
        </div>
      </div>
    </section>
    ${tarifas()}
    ${chamada('Leve sua empresa para a PAY AX', 'Abra a conta PJ pela internet.')}`;
}

function tarifas() {
  const linhas = I.tarifas ?? [];
  return secao('Tarifas', 'Valores praticados pela PAY AX.', linhas.length ? html`
    <div class="tabela-site"><table>
      <thead><tr><th>Serviço</th><th>Valor</th></tr></thead>
      <tbody>${linhas.map((t) => html`<tr><td>${t.servico}</td><td>${t.valor}</td></tr>`)}</tbody>
    </table></div>
    <p class="nota">A tabela oficial de tarifas fica disponível também nas agências de atendimento e com o seu gerente.</p>` : '');
}

function credito() {
  return html`
    ${banner({ img: 'propagandas/credito-escritorio-largo.jpg', espelhar: true, cor: '#B69CFF', selo: 'Crédito', titulo: 'Crédito sob medida ', destaque: 'para os seus planos.', texto: 'Empréstimos com parcelas fixas, para você e para a sua empresa.' })}
    <section class="site-secao">
      <div class="site-linha site-lado">
        <div class="lado-texto">
          <h2>Simule seu empréstimo</h2>
          <p class="muted">Parcelas fixas calculadas pela Tabela Price. Informe o valor, o prazo e a taxa para ver a parcela estimada.</p>
          <form id="simulador" class="simulador" novalidate>
            <div><label for="sim-valor">Valor desejado</label><input id="sim-valor" inputmode="numeric" value="10.000,00"></div>
            <div><label for="sim-prazo">Prazo</label>
              <select id="sim-prazo">${[6, 12, 18, 24, 36, 48].map((n) => html`<option value="${n}" ${n === 12 ? raw('selected') : ''}>${n} meses</option>`)}</select></div>
            <div><label for="sim-taxa">Taxa ao mês (%)</label><input id="sim-taxa" inputmode="decimal" value="2,49"></div>
          </form>
          <p class="nota">Simulação ilustrativa, sem valor de proposta. A taxa real, o CET e as condições dependem da análise de crédito.</p>
        </div>
        <div class="resultado-sim" id="resultado" aria-live="polite"></div>
      </div>
    </section>
    ${secao('Como contratar', null, html`<ol class="passos-site">
      <li><span>1</span><h3>Seja cliente</h3><p>Abra sua conta PAY AX pela internet.</p></li>
      <li><span>2</span><h3>Fale com o gerente</h3><p>Conte o valor e o prazo de que você precisa.</p></li>
      <li><span>3</span><h3>Análise</h3><p>A PAY AX avalia o crédito e apresenta a proposta.</p></li>
      <li><span>4</span><h3>Dinheiro na conta</h3><p>Aprovado, o valor é creditado e as parcelas aparecem no Internet Banking.</p></li>
    </ol>`, 'secao-clara')}
    ${chamada('Ainda não é cliente?', 'Abra sua conta e converse com um gerente PAY AX.')}`;
}

function seguranca() {
  return html`
    ${banner({ img: 'propagandas/rua-pedestres-largo.jpg', cor: '#5CE1FF', selo: 'Segurança', titulo: 'Sua senha protegida ', destaque: 'em cada acesso.', texto: 'Conheça as proteções do Internet Banking PAY AX e como evitar golpes.', acoes: false })}
    ${secao('Como protegemos a sua conta', null, cards([
      { icone: 'chave', titulo: 'Teclado virtual', texto: 'Cada tecla mostra dois números que mudam de posição a cada acesso. Quem observa não descobre a senha.' },
      { icone: 'auditoria', titulo: 'Duas senhas', texto: 'Uma senha para entrar e outra, diferente, para confirmar cada PIX, transferência e pagamento.' },
      { icone: 'emprestimos', titulo: 'Limite diário', texto: 'As saídas de dinheiro têm um limite por dia, que reduz o prejuízo em caso de golpe.' },
      { icone: 'olho', titulo: 'Bloqueio automático', texto: 'Tentativas de senha erradas bloqueiam o acesso temporariamente.' },
    ]))}
    ${secao('Dicas para evitar golpes', null, html`<ul class="lista-check lista-colunas">
      <li>${icone('check')} A PAY AX nunca liga, manda e-mail, SMS ou mensagem pedindo senhas ou códigos.</li>
      <li>${icone('check')} Não informe suas senhas a ninguém, nem a pessoas que dizem ser da PAY AX.</li>
      <li>${icone('check')} Confira o nome de quem vai receber antes de confirmar um PIX.</li>
      <li>${icone('check')} Desconfie de pedidos urgentes de dinheiro por mensagem, mesmo de conhecidos.</li>
      <li>${icone('check')} Acesse o Internet Banking digitando o endereço oficial, não por links recebidos.</li>
      <li>${icone('check')} Ao terminar, clique em Sair, principalmente em computadores compartilhados.</li>
    </ul>`, 'secao-clara')}
    ${aviso()}`;
}

function sobre() {
  return html`
    ${banner({ img: 'propagandas/cidade-sao-paulo-largo.jpg', cor: '#FF6FA5', selo: 'Sobre a PAY AX', titulo: 'O futuro ', destaque: 'em cada transação.', texto: 'Uma conta digital simples, segura e acessível, para pessoas e empresas.', acoes: false })}
    <section class="site-secao">
      <div class="site-linha site-lado">
        <div class="lado-texto">
          <h2>Quem somos</h2>
          <p>A PAY AX oferece conta digital para pessoas e empresas, com PIX, transferências, pagamentos e crédito,
            tudo acessível pelo Internet Banking.</p>
          <p>Nosso compromisso é com a simplicidade no dia a dia e com a segurança em cada operação: cada saída de dinheiro
            é autorizada somente pelo próprio cliente, com a senha de transação.</p>
        </div>
        <div class="valores">
          <div>${icone('auditoria')}<h3>Segurança</h3><p>Proteção em cada acesso e em cada transação.</p></div>
          <div>${icone('check')}<h3>Simplicidade</h3><p>Serviços claros, sem complicação.</p></div>
          <div>${icone('clientes')}<h3>Proximidade</h3><p>Atendimento por pessoas, com gerente dedicado.</p></div>
        </div>
      </div>
    </section>
    ${tarifas()}
    ${secao('Dados institucionais', null, html`<dl class="dados-inst">
      <div><dt>Razão social</dt><dd>${I.razaoSocial}</dd></div>
      <div><dt>CNPJ</dt><dd>${I.cnpj}</dd></div>
      <div><dt>Endereço</dt><dd>${I.endereco}</dd></div>
      <div><dt>Atendimento</dt><dd>${I.atendimento.telefone} · ${I.atendimento.email}</dd></div>
      <div><dt>Ouvidoria</dt><dd>${I.ouvidoria.telefone} · ${I.ouvidoria.email}</dd></div>
    </dl>`, 'secao-clara')}`;
}

const PERGUNTAS = [
  ['Conta', 'Como abro minha conta?', 'Clique em "Abra sua conta", preencha seus dados, escolha o tipo de conta e envie. Você recebe um número de protocolo para acompanhar a análise.'],
  ['Conta', 'Como acompanho a minha proposta?', 'Use "Acompanhe sua proposta" no topo do site e informe o protocolo e o CPF ou CNPJ usados na abertura.'],
  ['Conta', 'Quais tipos de conta existem?', 'Conta corrente, poupança e conta de pagamento, para pessoa física ou jurídica.'],
  ['Acesso', 'Como faço o primeiro acesso?', 'Com a conta aprovada, entre com o CPF ou CNPJ e a senha provisória entregue pela PAY AX. Em seguida você cria a senha de acesso e a senha de transação.'],
  ['Acesso', 'Como funciona o teclado virtual?', 'Cada botão mostra dois números (por exemplo, 1 ou 4). Clique no botão que contém cada dígito da sua senha. As posições mudam a cada acesso, então quem observa não descobre a senha.'],
  ['Acesso', 'Errei a senha várias vezes. E agora?', 'Por segurança o acesso fica bloqueado por alguns minutos. Se esqueceu a senha, fale com o atendimento PAY AX para receber uma nova senha provisória.'],
  ['PIX', 'Como envio um PIX?', 'No Internet Banking, abra PIX, informe a chave, confira o nome de quem vai receber, digite o valor e confirme com a senha de transação.'],
  ['PIX', 'Como recebo um PIX?', 'Informe a sua chave ou gere um QR Code de cobrança no Internet Banking. O valor entra na conta assim que o pagamento é feito.'],
  ['Pagamentos', 'Quais contas posso pagar?', 'Boletos bancários e contas de consumo (água, luz, telefone), digitando a linha digitável.'],
  ['Pagamentos', 'Existe limite para pagamentos e PIX?', 'Sim. Há um limite diário para saídas de dinheiro, que protege a sua conta.'],
  ['Segurança', 'A PAY AX pede minha senha por telefone?', 'Nunca. Não informe suas senhas a ninguém. Em caso de dúvida, encerre o contato e fale com os canais oficiais.'],
];

function ajuda() {
  const grupos = [...new Set(PERGUNTAS.map((p) => p[0]))];
  return html`
    <section class="site-ajuda-topo">
      <div class="site-linha">
        <h1>Como podemos ajudar?</h1>
        <input type="search" id="busca" placeholder="Busque por PIX, senha, abertura de conta..." aria-label="Buscar nas perguntas frequentes">
      </div>
    </section>
    <section class="site-secao">
      <div class="site-linha ajuda-grade">
        <div id="faq">${grupos.map((g) => html`<div class="faq-grupo"><h2>${g}</h2>
          ${PERGUNTAS.filter((p) => p[0] === g).map((p) => html`<details class="faq"><summary>${p[1]}</summary><p>${p[2]}</p></details>`)}</div>`)}
          <p class="muted hidden" id="sem-resultado">Nenhuma pergunta encontrada. Fale com o atendimento.</p>
        </div>
        <aside class="canais">
          <h2>Fale com a PAY AX</h2>
          <div class="canal">${icone('perfil')}<div><strong>Atendimento</strong><p>Telefone: ${I.atendimento.telefone}</p><p>Horário: ${I.atendimento.horario}</p></div></div>
          <div class="canal">${icone('transacoes')}<div><strong>E-mail</strong><p>${I.atendimento.email}</p></div></div>
          <div class="canal">${icone('auditoria')}<div><strong>Ouvidoria</strong><p>Telefone: ${I.ouvidoria.telefone}</p><p>E-mail: ${I.ouvidoria.email}</p></div></div>
          <a class="btn primario" href="${IB}">Acessar o Internet Banking</a>
        </aside>
      </div>
    </section>`;
}

// ===== Comportamentos =====
function ligar(nome) {
  if (nome === '') {
    vitrine($('#vitrine', app), { raizImg: IMG, modo: 'hero' });
    const doc = $('#documento', app);
    mascaraDocumento(doc);
    let tipo = 'PF';
    app.querySelectorAll('[data-tipo]').forEach((b) => b.addEventListener('click', () => {
      tipo = b.dataset.tipo;
      app.querySelectorAll('[data-tipo]').forEach((x) => x.classList.toggle('ativa', x === b));
      $('#rotulo-doc', app).textContent = tipo === 'PF' ? 'CPF' : 'CNPJ';
      doc.placeholder = tipo === 'PF' ? '000.000.000-00' : '00.000.000/0000-00';
      doc.value = '';
      doc.focus();
    }));
    $('#form-acesso', app).addEventListener('submit', (e) => {
      e.preventDefault();
      const d = doc.value.replace(/\D/g, '');
      const erro = $('#erro', app);
      if (d.length !== (tipo === 'PF' ? 11 : 14)) {
        erro.textContent = tipo === 'PF' ? 'Informe os 11 números do CPF.' : 'Informe os 14 números do CNPJ.';
        erro.classList.remove('hidden');
        return;
      }
      // O Internet Banking continua do passo da senha (o documento não vai na URL).
      try { sessionStorage.setItem('payax.site.documento', d); } catch { /* sem armazenamento: o cliente digita de novo */ }
      location.href = IB;
    });
  }
  if (nome === 'credito') simulador();
  if (nome === 'ajuda') {
    const busca = $('#busca', app);
    busca.addEventListener('input', () => {
      const q = busca.value.trim().toLowerCase();
      let algum = false;
      app.querySelectorAll('.faq').forEach((f) => {
        const ok = !q || f.textContent.toLowerCase().includes(q);
        f.hidden = !ok;
        if (ok) algum = true;
        if (q && ok) f.open = true;
      });
      app.querySelectorAll('.faq-grupo').forEach((g) => { g.hidden = ![...g.querySelectorAll('.faq')].some((f) => !f.hidden); });
      $('#sem-resultado', app).classList.toggle('hidden', algum);
    });
  }
}

/** Parcela pela Tabela Price: PMT = PV · i / (1 − (1 + i)^−n). */
export function parcelaPrice(valorCentavos, taxaMensal, meses) {
  if (taxaMensal <= 0) return Math.round(valorCentavos / meses);
  return Math.round((valorCentavos * taxaMensal) / (1 - (1 + taxaMensal) ** -meses));
}

function simulador() {
  const valor = $('#sim-valor', app);
  const prazo = $('#sim-prazo', app);
  const taxa = $('#sim-taxa', app);
  mascaraMoeda(valor);
  const res = $('#resultado', app);
  const calcular = () => {
    const pv = centavos(valor.value);
    const n = Number(prazo.value);
    const i = Number(taxa.value.replace(/\./g, '').replace(',', '.')) / 100;
    if (!(pv > 0) || !(i >= 0) || i > 0.2) {
      res.innerHTML = String(html`<p class="muted">Informe um valor e uma taxa entre 0% e 20% ao mês.</p>`);
      return;
    }
    const pmt = parcelaPrice(pv, i, n);
    res.innerHTML = String(html`
      <span class="rotulo">Parcela estimada</span>
      <strong class="parcela">${n}x de ${moeda(pmt)}</strong>
      <dl>
        <div><dt>Valor solicitado</dt><dd>${moeda(pv)}</dd></div>
        <div><dt>Total a pagar</dt><dd>${moeda(pmt * n)}</dd></div>
        <div><dt>Juros no período</dt><dd>${moeda(pmt * n - pv)}</dd></div>
      </dl>
      <a class="btn ouro" href="${IB}#/abrir-conta">Quero ser cliente</a>`);
  };
  [valor, prazo, taxa].forEach((el) => el.addEventListener('input', calcular));
  prazo.addEventListener('change', calcular);
  calcular();
}

window.addEventListener('hashchange', desenhar);
desenhar();
