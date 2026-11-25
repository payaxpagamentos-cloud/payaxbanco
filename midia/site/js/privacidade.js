/*
 * Política de privacidade: a página é fixa, mas os dados da empresa vêm de js/config.js.
 * Enquanto razão social, CNPJ e e-mail não estiverem preenchidos, a página não inventa nada —
 * ela mostra apenas o que existe e manda a pessoa falar pelo formulário do site.
 */
(function () {
  'use strict';
  const config = window.VAI_CONFIG || {};
  const nome = String(config.companyName || 'VAI MÍDIA').trim();
  const email = String(config.email || '').trim();
  const razao = String(config.razaoSocial || '').trim();
  const cnpj = String(config.cnpj || '').trim();

  const alvoNome = document.getElementById('empresa-nome');
  if (alvoNome) alvoNome.textContent = nome;

  // Com e-mail oficial configurado, ele vira o canal do pedido de acesso ou exclusão.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const alvo = document.getElementById('contato-privacidade');
    if (alvo) {
      alvo.textContent = '';
      alvo.append('Escreva para ');
      const link = document.createElement('a');
      link.href = 'mailto:' + email + '?subject=' + encodeURIComponent('Privacidade — pedido sobre meus dados');
      link.textContent = email;
      alvo.append(link, '. Você também pode usar o formulário do site, dizendo no campo de detalhes que o assunto é privacidade.');
      alvo.normalize();
    }
  }

  // A identificação do controlador só aparece quando a empresa preenche razão social e CNPJ.
  if (razao && cnpj) {
    const alvo = document.getElementById('identificacao-empresa');
    if (alvo) {
      alvo.textContent = `Controlador dos dados: ${razao}, CNPJ ${cnpj}.`;
      alvo.hidden = false;
    }
  }
})();
