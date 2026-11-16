/* PAY AX — interação do site. A ligação com o sistema (login, links) fica em config.js (window.PAYAX_SITE). */
(() => {
  'use strict';
  const config = () => window.PAYAX_SITE || {};
  const form = document.querySelector('[data-login]');
  const submit = form.querySelector('[type="submit"]');
  const email = form.querySelector('[name="email"]');
  const password = form.querySelector('[name="password"]');
  const status = form.querySelector('[data-login-status]');
  const toggle = form.querySelector('[data-eye]');
  const submitText = submit.querySelector('[data-submit-text]');
  const dialog = document.querySelector('[data-dialog]');
  const header = document.querySelector('.header');
  const mobile = document.querySelector('[data-mobile-access]');
  let busy = false;
  submit.disabled = false;

  // Topo fixo: ganha sombra quando a página rola, para separar do conteúdo.
  const sombra = () => header.classList.toggle('rolou', window.scrollY > 4);
  window.addEventListener('scroll', sombra, { passive: true });
  sombra();

  mobile.addEventListener('click', () => {
    const open = header.classList.toggle('access-open');
    mobile.setAttribute('aria-expanded', String(open));
    if (open) email.focus();
  });
  toggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    toggle.querySelector('[data-eye-slash]').toggleAttribute('hidden', !show);
  });
  form.addEventListener('input', () => { status.hidden = true; });
  function loginError(message) {
    status.textContent = message;
    status.hidden = false;
    status.focus();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    status.hidden = true;
    const signIn = config().signIn;
    if (typeof signIn !== 'function') {
      loginError('Acesso indisponível no momento. Tente novamente mais tarde.');
      return;
    }
    busy = true;
    submit.disabled = true;
    submitText.textContent = 'Acessando…';
    form.setAttribute('aria-busy', 'true');
    try {
      await signIn({ email: email.value.trim(), password: password.value, portal: 'cliente' });
    } catch (error) {
      // Verificação em duas etapas cancelada: volta ao formulário sem mensagem de erro.
      if (!error?.cancelado) loginError(error?.mensagem || 'Não foi possível entrar. Confira seus dados e tente novamente.');
    } finally {
      busy = false;
      submit.disabled = false;
      submitText.textContent = 'Entrar';
      form.removeAttribute('aria-busy');
    }
  });

  // O que cada solução faz — fiel ao que o sistema entrega hoje.
  const services = {
    pix: ['Pix', 'Boletos com QR Code Pix (Bolepix): o pagador escolhe entre o código de barras e o Pix. Pago por Pix, o valor segue para a conta da sua empresa já sem a tarifa, sem pedir saque.'],
    boletos: ['Boletos', 'Boletos registrados no Bradesco, com a sua empresa identificada como beneficiária final. Emissão avulsa ou importada do sistema da sua empresa, com multa e juros dentro do Código de Defesa do Consumidor.'],
    cobrancas: ['Cobranças', 'Acompanhe cada título — em aberto, vencido, pago ou baixado — com o histórico de cada etapa. Na Área do Cliente: extrato, transferências, relatórios e o boleto de cada pagador num link.'],
    conciliacao: ['Conciliação', 'O retorno do banco é processado automaticamente: o pagamento é baixado e o valor segue para a sua empresa. Integrado ao sistema de gestão, o título é baixado lá também, sem digitação.']
  };
  const fallback = {
    contact: ['Atendimento PAY AX', 'Fale com a equipe PAY AX que atende a sua empresa para conhecer as soluções e começar.'],
    recovery: ['Esqueci minha senha', 'Peça ao administrador do acesso da sua empresa (Cadastro e acessos → Acessos) ou ao seu gerente de conta PAY AX para gerar uma senha provisória. Você troca por uma sua no primeiro acesso.'],
    integrations: ['Integrações', 'Importação automática dos títulos do sistema de gestão da sua empresa e baixa nele quando o boleto é pago. Sistema homologado hoje: IXC Provedor. Novos sistemas entram após homologação pela PAY AX.'],
    privacy: ['Privacidade', 'Consulte a política de privacidade aplicável à sua conta junto à PAY AX.'],
    terms: ['Termos de uso', 'Os termos de uso são apresentados na contratação. Fale com a equipe PAY AX para receber a versão vigente.']
  };
  function safeNavigate(raw) {
    let target;
    try { target = new URL(raw, location.href); } catch { return false; }
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    location.assign(target.href);
    return true;
  }
  function showInfo(title, body, service) {
    dialog.querySelector('[data-dialog-title]').textContent = title;
    dialog.querySelector('[data-dialog-body]').textContent = body;
    dialog.querySelector('[data-dialog-contact]').hidden = !service;
    dialog.showModal();
  }
  function action(key) {
    if (config().links?.[key]) {
      safeNavigate(config().links[key]);
      return;
    }
    const item = fallback[key];
    if (item) showInfo(item[0], item[1], false);
  }
  document.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', () => action(button.dataset.action));
  });
  document.querySelectorAll('[data-service]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.service;
      const url = config().solutions?.[key];
      if (url) { safeNavigate(url); return; }
      const item = services[key];
      if (item) showInfo(item[0], item[1], true);
    });
  });
  dialog.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.querySelector('[data-dialog-contact]').addEventListener('click', () => {
    dialog.close();
    action('contact');
  });
  // Clique fora da janela não fecha: só o X ou o botão Fechar (como no restante do sistema).

  const video = document.querySelector('[data-globe-video]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const allowed = () => !motion.matches && !navigator.connection?.saveData;
  function syncVideo() {
    if (!allowed() || document.hidden) { video.pause(); return; }
    if (!video.getAttribute('src')) video.src = video.dataset.src;
    video.muted = true;
    const play = video.play();
    if (play && typeof play.catch === 'function') play.catch(() => {});
  }
  motion.addEventListener?.('change', syncVideo);
  document.addEventListener('visibilitychange', syncVideo);
  syncVideo();
})();
