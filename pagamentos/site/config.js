/*
 * PAY AX — ligação do site (payax.com.br) com o sistema.
 *
 * O acesso usa as mesmas rotas da Área do Cliente (/cliente/api/auth/...), inclusive a verificação em
 * duas etapas, e grava a sessão no mesmo lugar que ela: ao entrar, o cliente cai direto no painel.
 * Nada de conta de demonstração nem atalho: quem não tem acesso válido não entra.
 */
(() => {
  'use strict';
  const SESSAO = 'payax.cliente';
  const PAINEL = '/cliente/#/inicio';

  /** Erro com a mensagem que o site mostra. `cancelado` = a pessoa fechou a verificação (sem mensagem). */
  const falha = (mensagem, extra = {}) => Object.assign(new Error(mensagem), { mensagem }, extra);

  async function postar(caminho, corpo) {
    let r;
    try {
      r = await fetch(`/cliente/api${caminho}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), credentials: 'same-origin',
      });
    } catch {
      throw falha('Sem conexão com a PAY AX. Verifique a internet e tente de novo.');
    }
    const d = await r.json().catch(() => ({}));
    if (r.status === 429) throw falha('Muitas tentativas seguidas. Aguarde um minuto e tente de novo.', { status: 429 });
    if (!r.ok) throw falha(d.erro || 'Não foi possível entrar. Confira seus dados e tente novamente.', { status: r.status });
    return d;
  }

  function entrarNoPainel(sessao) {
    try { localStorage.setItem(SESSAO, JSON.stringify(sessao)); } catch { /* sem armazenamento: o painel pede o login de novo */ }
    location.assign(PAINEL);
  }

  /**
   * Segunda etapa: abre a janela do código e só resolve quando o código é aceito.
   * Código errado mantém a janela aberta para tentar de novo; verificação vencida ou cancelada encerra.
   */
  function pedirCodigo(desafio) {
    const janela = document.querySelector('[data-dialog-2fa]');
    const form = janela.querySelector('[data-code-form]');
    const campo = janela.querySelector('[name="codigo"]');
    const aviso = janela.querySelector('[data-code-status]');
    const botao = janela.querySelector('[data-code-submit]');
    return new Promise((resolve, reject) => {
      let ocupado = false;
      const avisar = (t) => { aviso.textContent = t; aviso.hidden = false; };
      const encerrar = (erro, sessao) => {
        form.removeEventListener('submit', enviar);
        campo.removeEventListener('input', digitou);
        janela.removeEventListener('cancel', cancelar);
        janela.querySelectorAll('[data-code-cancel]').forEach((b) => b.removeEventListener('click', cancelar));
        if (janela.open) janela.close();
        if (erro) reject(erro); else resolve(sessao);
      };
      async function enviar(e) {
        e.preventDefault();
        if (ocupado) return;
        const codigo = campo.value.replace(/\D/g, '');
        if (codigo.length !== 6) { avisar('O código tem 6 dígitos.'); campo.focus(); return; }
        ocupado = true; botao.disabled = true; aviso.hidden = true;
        try {
          encerrar(null, await postar('/auth/2fa', { desafio, codigo }));
        } catch (erro) {
          if (/expirou/i.test(erro.mensagem)) { encerrar(erro); return; }
          avisar(erro.mensagem); campo.select(); campo.focus();
        } finally {
          ocupado = false; botao.disabled = false;
        }
      }
      function digitou() {
        aviso.hidden = true;
        if (campo.value.replace(/\D/g, '').length === 6) form.requestSubmit();
      }
      function cancelar(e) { e?.preventDefault(); encerrar(falha('', { cancelado: true })); }

      campo.value = ''; aviso.hidden = true; botao.disabled = false;
      form.addEventListener('submit', enviar);
      campo.addEventListener('input', digitou);
      janela.addEventListener('cancel', cancelar);
      janela.querySelectorAll('[data-code-cancel]').forEach((b) => b.addEventListener('click', cancelar));
      janela.showModal();
      campo.focus();
    });
  }

  async function signIn({ email, password }) {
    const d = await postar('/auth/login', { email, senha: password });
    entrarNoPainel(d.precisa_2fa ? await pedirCodigo(d.desafio) : d);
  }

  window.PAYAX_SITE = {
    signIn,
    links: { privacy: '/privacidade' },
  };
})();
