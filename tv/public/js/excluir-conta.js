/**
 * Excluir a própria conta, de dentro do app.
 *
 * A App Store exige isso de qualquer aplicativo que permita criar conta (regra 5.1.1(v)) e a
 * LGPD chama de direito à eliminação. Fica aqui, num módulo só, porque o caminho precisa existir
 * em dois lugares: em *Minha conta* e na tela de planos — quem acabou de se cadastrar e ainda não
 * assinou para nessa tela, e tem o mesmo direito de apagar a conta.
 */

import { api, sessao, perfil as perfilGuardado } from './api.js';
import { el, acao, modal, toast } from './ui.js';

/** Abre a confirmação e, se o assinante seguir, apaga a conta e volta para a entrada. */
export async function excluirConta() {
  const senha = await modal('Excluir minha conta', (fechar) => {
    const campo = el('input', { type: 'password', placeholder: 'Sua senha', autocomplete: 'current-password' });
    const confirmar = el('button', { class: 'btn perigo' }, 'Excluir para sempre');
    confirmar.addEventListener('click', () => fechar(campo.value));
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') fechar(campo.value); });
    return [
      el('p', { class: 'mudo' }, 'Vão ser apagados: seu cadastro, os perfis, a sua lista e o que você já assistiu. A assinatura é cancelada agora e o acesso acaba na hora.'),
      el('p', { class: 'pequeno mudo' }, 'As faturas já pagas continuam guardadas, sem seus dados, porque são registro fiscal obrigatório.'),
      el('label', { class: 'campo' }, 'Confirme com a sua senha', campo),
      el('div', { class: 'linha fim', style: 'margin-top:8px' },
        el('button', { class: 'btn vazio', onclick: () => fechar(null) }, 'Agora não'), confirmar),
    ];
  });
  if (!senha) return false;

  const r = await api.del('/conta', { senha });
  toast(r?.aviso ?? 'Conta excluída.');
  sessao.limpar();
  perfilGuardado.limpar();
  window.dispatchEvent(new CustomEvent('tv:sair'));
  return true;
}

/** Botão pronto, com o aviso de ação sem volta. */
export function botaoExcluirConta({ rotulo = 'Excluir minha conta', classe = 'btn pequeno perigo' } = {}) {
  const b = el('button', { class: classe }, rotulo);
  b.addEventListener('click', () => acao(b, excluirConta));
  return b;
}
