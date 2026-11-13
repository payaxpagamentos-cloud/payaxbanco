/*
 * Autenticação em duas etapas na tela, compartilhada pelo Backoffice e pelo Internet Bank —
 * as rotas são as mesmas em cada área (/auth/2fa/...), só muda o endereço base da API.
 */
import { el, campo, lerForm, acao, aviso, toast, icone, copiar } from './ui.js';

/** Segunda etapa do login: a pessoa informa o código do aplicativo. */
export function formularioDesafio(api, { desafio, aoEntrar, aoVoltar }) {
  const entrada = campo({
    nome: 'codigo', rotulo: 'Código do aplicativo', obrigatorio: true,
    ajuda: 'Os 6 dígitos que aparecem no seu Google Authenticator, Authy ou similar',
    atributos: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '000000' },
  });
  const form = el('form', { onsubmit: (e) => { e.preventDefault(); enviar(); } }, entrada);
  const botao = el('button', { class: 'botao', style: 'width:100%;justify-content:center', type: 'submit' }, 'Entrar');
  form.append(el('div', { style: 'margin-top:12px' }, botao));
  const enviar = () => acao(botao, async () => {
    const d = await api.post('/auth/2fa', { desafio, codigo: lerForm(form).codigo });
    aoEntrar(d);
  });
  // Com 6 dígitos, envia sozinho — ninguém gosta de digitar e ainda clicar.
  entrada.querySelector('input').addEventListener('input', (e) => {
    if (String(e.target.value).replace(/\D/g, '').length === 6) enviar();
  });
  setTimeout(() => entrada.querySelector('input')?.focus(), 50);
  return el('div', {},
    el('p', { class: 'apoio', style: 'margin-bottom:12px' }, 'Confirme com o código do seu aplicativo de autenticação.'),
    form,
    aoVoltar ? el('button', { class: 'botao sutil', style: 'margin-top:10px', onclick: aoVoltar }, icone('voltar'), 'Entrar com outra conta') : null);
}

/** Bloco de configuração: ativar, mostrar o QR Code e desligar. */
export function blocoDoisFatores(api, { ativo, exigido = false, aoMudar }) {
  const caixa = el('div', {});

  const desenhar = () => {
    if (ativo) {
      caixa.replaceChildren(
        aviso('A autenticação em duas etapas está ativa nesta conta.', 'ok'),
        exigido
          ? el('p', { style: 'margin-top:8px;color:var(--texto-3);font-size:12.5px' },
            'Ela é obrigatória para a equipe e não pode ser desligada. Se você trocou de celular, peça ao administrador para redefinir.')
          : el('button', { class: 'botao sec', style: 'margin-top:10px', onclick: () => desligar() }, 'Desligar'),
      );
      return;
    }
    caixa.replaceChildren(
      exigido ? aviso('A autenticação em duas etapas é obrigatória para a equipe. Configure para continuar.', 'aviso') : null,
      el('p', { style: 'color:var(--texto-2);font-size:13px;margin:8px 0' },
        'Use um aplicativo de autenticação (Google Authenticator, Microsoft Authenticator, Authy). A cada acesso, além da senha, você informa o código de 6 dígitos.'),
      botaoIniciar,
    );
  };

  const botaoIniciar = el('button', { class: 'botao' }, icone('escudo'), 'Configurar agora');
  botaoIniciar.addEventListener('click', () => acao(botaoIniciar, async () => {
    const d = await api.post('/auth/2fa/iniciar', {});
    const qr = el('div', { style: 'background:#fff;padding:10px;border:1px solid var(--borda);border-radius:10px;width:188px' });
    qr.innerHTML = d.qr_svg; // SVG gerado pelo nosso próprio servidor
    qr.querySelector('svg')?.setAttribute('style', 'width:168px;height:168px');

    const entrada = campo({ nome: 'codigo', rotulo: 'Código do aplicativo', obrigatorio: true,
      atributos: { inputmode: 'numeric', maxlength: 7, placeholder: '000000' } });
    const form = el('form', { onsubmit: (e) => { e.preventDefault(); confirmar(); } }, entrada);
    const confirmarBotao = el('button', { class: 'botao', type: 'submit' }, 'Ativar');
    form.append(el('div', { style: 'margin-top:10px' }, confirmarBotao));
    const confirmar = () => acao(confirmarBotao, async () => {
      await api.post('/auth/2fa/ativar', { codigo: lerForm(form).codigo });
      ativo = true;
      toast('Autenticação em duas etapas ativada.', 'ok');
      desenhar();
      aoMudar?.(true);
    });

    caixa.replaceChildren(
      el('div', { style: 'display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start' },
        qr,
        el('div', { style: 'flex:1;min-width:240px' },
          el('p', { style: 'font-size:13px;color:var(--texto-2)' }, '1. Leia o QR Code no aplicativo de autenticação.'),
          el('p', { style: 'font-size:13px;color:var(--texto-2);margin:6px 0' }, '2. Digite abaixo os 6 dígitos que ele mostrar.'),
          form,
          el('details', { style: 'margin-top:12px' },
            el('summary', { style: 'font-size:12.5px;color:var(--texto-3);cursor:pointer' }, 'Não consigo ler o código'),
            el('p', { style: 'font-size:12.5px;color:var(--texto-2);margin-top:6px' }, 'Cadastre esta chave no aplicativo:'),
            el('div', { class: 'codigo' }, d.segredo),
            el('button', { class: 'botao sutil pequeno', type: 'button', onclick: () => copiar(d.segredo, 'Chave copiada.') }, icone('copiar'), 'Copiar chave')))),
    );
  }));

  const desligar = () => {
    const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
      campo({ nome: 'senha', rotulo: 'Sua senha', tipo: 'password', obrigatorio: true }),
      campo({ nome: 'codigo', rotulo: 'Código do aplicativo', obrigatorio: true, atributos: { inputmode: 'numeric', maxlength: 7 } }));
    const b = el('button', { class: 'botao perigo' }, 'Desligar');
    b.addEventListener('click', () => acao(b, async () => {
      await api.post('/auth/2fa/desativar', lerForm(form));
      ativo = false;
      toast('Autenticação em duas etapas desligada.');
      desenhar();
      aoMudar?.(false);
    }));
    caixa.replaceChildren(
      aviso('Para desligar, confirme a senha e um código atual — assim só quem está com o celular na mão consegue.', 'aviso'),
      el('div', { style: 'margin-top:10px' }, form),
      el('div', { style: 'margin-top:10px;display:flex;gap:8px' }, b,
        el('button', { class: 'botao sec', onclick: () => desenhar() }, 'Cancelar')));
  };

  desenhar();
  return caixa;
}
