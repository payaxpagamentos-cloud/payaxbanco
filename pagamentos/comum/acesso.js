/*
 * Tela de acesso (entrada, segunda etapa, troca de senha) das duas áreas: à esquerda a arte da marca —
 * o logotipo, "O futuro em cada transação." e o prédio —, à direita o formulário. No celular, a arte
 * vira uma faixa curta no topo e o formulário ocupa a tela.
 */
import { el, icone, campo, lerForm, modal, acao } from './ui.js';
import { letreiro } from './marca.js';

const CHAVE_EMAIL = 'payax.acesso.email';
const lerEmail = () => { try { return localStorage.getItem(CHAVE_EMAIL) ?? ''; } catch { return ''; } };
const guardarEmail = (v) => { try { if (v) localStorage.setItem(CHAVE_EMAIL, v); else localStorage.removeItem(CHAVE_EMAIL); } catch { /* sem armazenamento */ } };

/**
 * Moldura da tela de acesso.
 * @param {{area: string, titulo: string, subtitulo?: string, conteudo: Node|Node[], restrito: string,
 *   ajuda: string, privacidade: string}} o
 */
export function telaAcesso({ area, titulo, subtitulo, conteudo, restrito, ajuda, privacidade }) {
  const verAjuda = () => {
    const m = modal({ titulo: 'Precisa de ajuda?', corpo: [el('p', {}, ajuda)],
      acoes: [el('button', { class: 'botao', onclick: () => m.fechar() }, 'Entendi')] });
  };
  return el('div', { class: 'acesso' },
    el('aside', { class: 'acesso-arte' },
      el('div', { class: 'acesso-logo' }, letreiro({ altura: 46 })),
      el('div', { class: 'acesso-frase' },
        // Duas linhas fixas, em qualquer tela: "O futuro em cada" / "transação."
        el('h2', {}, 'O futuro em cada', el('br'), el('span', {}, 'transação.')),
        el('p', {}, 'Conectando negócios. Movendo possibilidades.')),
      el('div', { class: 'acesso-assinatura' }, el('span', { class: 'traco' }), 'PAY AX • PAGAMENTOS')),
    el('main', { class: 'acesso-lado' },
      el('header', { class: 'acesso-topo' },
        el('div', { class: 'acesso-logo-movel' }, letreiro({ altura: 26, cor: '#0a1526', degrade: ['#00c3ef', '#1265d6'], sombra: '#0a4fb0' })),
        el('button', { type: 'button', class: 'acesso-ajuda', onclick: verAjuda }, icone('fone'), 'Precisa de ajuda?')),
      el('div', { class: 'acesso-caixa' },
        el('span', { class: 'acesso-area' }, area),
        el('h1', {}, titulo),
        subtitulo ? el('p', { class: 'acesso-sub' }, subtitulo) : null,
        conteudo),
      el('footer', { class: 'acesso-rodape' },
        el('p', { class: 'acesso-restrito' }, icone('cadeado'), restrito),
        el('a', { class: 'link-privacidade', href: 'privacidade', target: '_blank', rel: 'noopener' }, privacidade))));
}

/**
 * Formulário de entrada: e-mail (lembrado, se a pessoa quiser), senha com mostrar/ocultar,
 * "Esqueci minha senha" e o botão Entrar. `entrar(dados)` faz o login; erros viram aviso na tela.
 */
export function formularioEntrada({ placeholderEmail, esqueci, entrar }) {
  const lembrado = lerEmail();
  const senha = el('input', { type: 'password', name: 'senha', required: true, autocomplete: 'current-password', placeholder: '••••••••' });
  const olho = el('button', { type: 'button', class: 'acesso-olho', 'aria-label': 'Mostrar a senha', onclick: () => {
    const mostrar = senha.type === 'password';
    senha.type = mostrar ? 'text' : 'password';
    olho.replaceChildren(icone(mostrar ? 'olho-fechado' : 'olho'));
    olho.setAttribute('aria-label', mostrar ? 'Ocultar a senha' : 'Mostrar a senha');
  } }, icone('olho'));
  const lembrar = el('input', { type: 'checkbox', name: 'lembrar', checked: Boolean(lembrado) });
  const verEsqueci = () => {
    const m = modal({ titulo: 'Esqueci minha senha', corpo: [el('p', {}, esqueci)],
      acoes: [el('button', { class: 'botao', onclick: () => m.fechar() }, 'Entendi')] });
  };
  const form = el('form', { class: 'acesso-form', onsubmit: (e) => { e.preventDefault(); enviar(); } },
    campo({ nome: 'email', rotulo: 'E-mail', tipo: 'email', valor: lembrado, obrigatorio: true,
      atributos: { autocomplete: 'username', placeholder: placeholderEmail } }),
    el('label', { class: 'campo-form' }, el('span', {}, 'Senha'), el('div', { class: 'acesso-senha' }, senha, olho)),
    el('div', { class: 'acesso-opcoes' },
      el('label', { class: 'acesso-lembrar' }, lembrar, 'Lembrar acesso'),
      el('button', { type: 'button', class: 'acesso-link', onclick: verEsqueci }, 'Esqueci minha senha')),
    el('button', { class: 'botao acesso-entrar', type: 'submit' }, 'Entrar', icone('seta')));
  const botao = form.querySelector('.acesso-entrar');
  const enviar = () => acao(botao, async () => {
    const d = lerForm(form);
    guardarEmail(lembrar.checked ? d.email : '');
    await entrar({ email: d.email, senha: d.senha });
  });
  setTimeout(() => (lembrado ? senha : form.querySelector('input'))?.focus(), 0);
  return form;
}
