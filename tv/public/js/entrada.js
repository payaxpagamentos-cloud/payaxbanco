import { api, sessao, perfil as perfilGuardado } from './api.js';
import { el, marca, lerForm, acao, toast, icone, dinheiro, QUALIDADES, limpar } from './ui.js';
import { botaoExcluirConta } from './excluir-conta.js';
import { carrosselEntrada } from './vitrine.js';
import { iconeLinha } from './login-icones.js';
import { CARTAZES_DEMO } from './cartazes-demo.js';

const campo = (rotulo, attrs) => el('label', { class: 'campo' }, rotulo, el('input', attrs));

/**
 * Tela de entrada, no layout aprovado pelo cliente: apresentação e cartazes à esquerda,
 * cartão de vidro com o formulário à direita, sobre a arte cinematográfica.
 *
 * Os quatro cartazes vêm do catálogo publicado e trocam pelos quatro seguintes a cada 6 s
 * (carrossel em vitrine.js). Sem catálogo, a faixa some e o resto da tela continua inteiro.
 */
export function telaEntrada(raiz, { aoEntrar }) {
  let modo = 'entrar';
  let carrossel = null;

  const recado = el('p', { class: 'form-feedback', id: 'form-feedback', role: 'status', 'aria-live': 'polite', hidden: true });
  const mostrarRecado = (texto, bom = false) => {
    recado.textContent = texto;
    recado.classList.toggle('is-success', bom);
    recado.hidden = false;
  };

  const concluir = (r, lembrar = true) => {
    sessao.set({ token: r.token, usuario: r.usuario }, { lembrar });
    perfilGuardado.limpar();
    carrossel?.destruir();
    aoEntrar(r);
  };

  // ---------- campos ----------

  const campoIcone = (id, rotulo, icone, attrs, extra = null) => el('div', { class: 'field' },
    el('label', { for: id }, rotulo),
    el('div', { class: 'input-wrap' },
      (() => { const i = iconeLinha(icone); i.classList.add('field-icon'); return i; })(),
      el('input', { id, ...attrs }),
      extra));

  const olho = (campoSenha) => {
    const b = el('button', { class: 'password-toggle', type: 'button', 'aria-label': 'Mostrar senha', 'aria-controls': campoSenha, 'aria-pressed': 'false' }, iconeLinha('eye'));
    b.addEventListener('click', () => {
      const alvo = document.getElementById(campoSenha);
      const escondida = alvo.type === 'password';
      alvo.type = escondida ? 'text' : 'password';
      b.setAttribute('aria-label', escondida ? 'Ocultar senha' : 'Mostrar senha');
      b.setAttribute('aria-pressed', String(escondida));
      b.replaceChildren(iconeLinha(escondida ? 'eye-off' : 'eye'));
      alvo.focus({ preventScroll: true });
    });
    return b;
  };

  const botaoEnviar = (texto) => el('button', { class: 'submit-button', type: 'submit' },
    el('span', { dataset: { rotulo: '1' } }, texto),
    (() => { const i = iconeLinha('arrow'); i.classList.add('submit-arrow'); return i; })(),
    el('span', { class: 'spinner', 'aria-hidden': 'true', hidden: true }));

  /** Liga o envio do formulário: trava o botão, mostra o erro no lugar certo e não loga senha. */
  const aoEnviar = (f, executar) => {
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = f.querySelector('.submit-button');
      if (botao.disabled) return;
      recado.hidden = true;
      botao.disabled = true;
      f.setAttribute('aria-busy', 'true');
      botao.querySelector('[data-rotulo]').textContent = modo === 'entrar' ? 'Entrando…' : 'Criando…';
      botao.querySelector('.submit-arrow').hidden = true;
      botao.querySelector('.spinner').hidden = false;
      try {
        await executar();
      } catch (err) {
        mostrarRecado(err?.message || 'Não foi possível concluir. Tente de novo.');
        botao.disabled = false;
        f.removeAttribute('aria-busy');
        botao.querySelector('[data-rotulo]').textContent = modo === 'entrar' ? 'Entrar' : 'Criar minha conta';
        botao.querySelector('.submit-arrow').hidden = false;
        botao.querySelector('.spinner').hidden = true;
      }
    });
  };

  // ---------- formulários ----------

  const formEntrar = () => {
    const lembrar = el('input', { id: 'remember', name: 'remember', type: 'checkbox', checked: true });
    const f = el('form', { id: 'login-form', method: 'post', novalidate: false },
      campoIcone('email', 'E-mail', 'mail', { name: 'email', type: 'email', placeholder: 'voce@email.com', autocomplete: 'username', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: true }),
      campoIcone('password', 'Senha', 'lock', { name: 'senha', type: 'password', placeholder: '••••••••', autocomplete: 'current-password', required: true }, olho('password')),
      el('div', { class: 'form-options' },
        el('label', { class: 'remember' }, lembrar, el('span', {}, 'Lembrar de mim')),
        el('button', { class: 'text-link forgot-link', type: 'button', onclick: () => mostrarRecado(RECADO_SENHA) }, 'Esqueci minha senha')),
      recado,
      botaoEnviar('Entrar'));
    aoEnviar(f, async () => {
      const d = lerForm(f);
      concluir(await api.post('/auth/login', { email: d.email, senha: d.senha }), lembrar.checked);
    });
    return f;
  };

  const formCadastro = () => {
    const f = el('form', { id: 'login-form', method: 'post' },
      campoIcone('nome', 'Nome completo', 'help', { name: 'nome', type: 'text', placeholder: 'Seu nome', autocomplete: 'name', maxlength: 120, required: true }),
      campoIcone('email', 'E-mail', 'mail', { name: 'email', type: 'email', placeholder: 'voce@email.com', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: true }),
      campoIcone('telefone', 'Celular com DDD (opcional)', 'help', { name: 'telefone', type: 'tel', placeholder: '(11) 99999-0000', autocomplete: 'tel', inputmode: 'tel' }),
      campoIcone('password', 'Senha (mínimo 8 caracteres)', 'lock', { name: 'senha', type: 'password', placeholder: '••••••••', autocomplete: 'new-password', minlength: 8, required: true }, olho('password')),
      el('p', { class: 'login-nota' }, 'Depois de criar a conta você escolhe o plano. Sem assinatura ativa, o conteúdo fica bloqueado.'),
      recado,
      botaoEnviar('Criar minha conta'));
    aoEnviar(f, async () => {
      const d = lerForm(f);
      if (!d.telefone) delete d.telefone;
      concluir(await api.post('/auth/cadastro', d));
      toast('Conta criada! Escolha seu plano.');
    });
    return f;
  };

  // ---------- montagem ----------

  const conteudo = el('div', { class: 'login-card-content' });
  let primeiroDesenho = true;

  const trocarModo = (novo) => { modo = novo; recado.hidden = true; desenharCartao(); };

  const desenharCartao = () => {
    const entrando = modo === 'entrar';
    limpar(conteudo,
      el('div', { class: 'login-topo' },
        (() => { const i = iconeLinha('play'); i.classList.add('login-play'); return i; })(),
        el('h2', { id: 'login-heading' }, entrando ? 'Bem-vindo' : 'Criar conta'),
        el('p', { class: 'login-subtitle' }, entrando ? 'Entre para continuar assistindo.' : 'Leva menos de um minuto.')),
      entrando ? formEntrar() : formCadastro(),
      el('div', { class: 'signup-line' },
        el('span', {}, entrando ? 'Ainda não tem conta? ' : 'Já tem conta? ',
          el('button', { class: 'text-link', type: 'button', onclick: () => trocarModo(entrando ? 'cadastro' : 'entrar') }, entrando ? 'Criar conta' : 'Entrar'))),
      el('p', { class: 'secure-note' }, iconeLinha('lock'), 'Acesso seguro'));
    // Só põe o cursor no campo quando a pessoa troca de aba (Entrar / Criar conta). Ao abrir a
    // tela, não: o cursor piscando sozinho incomoda, e no celular faz o teclado subir sem pedido.
    if (!primeiroDesenho) conteudo.querySelector('input')?.focus({ preventScroll: true });
    primeiroDesenho = false;
  };
  desenharCartao();

  const cartazes = el('div', { class: 'catalogue-slot' });

  limpar(raiz, el('div', { class: 'login-tela' },
    el('div', { class: 'cinema', 'aria-hidden': 'true' }),
    el('div', { class: 'page-shell' },
      el('header', { class: 'page-header' },
        el('div', { class: 'brand' },
          (() => { const i = iconeLinha('tv'); i.classList.add('brand-icon'); return i; })(),
          el('span', { class: 'brand-name' }, el('span', { class: 'brand-red' }, 'PLAY'), 'TECH'),
          el('span', { class: 'vip-badge' }, 'VIP')),
        el('button', { class: 'help-link', type: 'button', onclick: () => mostrarRecado(RECADO_AJUDA) },
          iconeLinha('help'), el('span', {}, 'Precisa de ajuda?'))),

      el('main', { class: 'main-layout' },
        el('section', { class: 'welcome' },
          el('div', { class: 'welcome-copy' },
            el('h1', { id: 'welcome-title' }, 'Seu próximo play', el('br'), 'começa aqui.'),
            el('p', { class: 'welcome-subtitle' }, 'Filmes, séries e TV ao vivo em um só lugar.'),
            el('ul', { class: 'benefits', 'aria-label': 'Entretenimento para você' },
              el('li', {}, 'Filmes e séries'),
              el('li', {}, 'TV ao vivo'),
              el('li', {}, 'Onde você estiver'))),
          cartazes),
        el('section', { class: 'login-card', 'aria-labelledby': 'login-heading' }, conteudo)),

      el('footer', { class: 'page-footer' },
        el('p', { class: 'footer-brand' }, 'PLAYTECH ', el('span', {}, 'VIP')),
        el('nav', { 'aria-label': 'Informações legais' },
          el('a', { href: 'termos.html' }, 'Termos de uso'),
          el('span', { 'aria-hidden': 'true' }, '·'),
          el('a', { href: 'privacidade.html' }, 'Privacidade'))))));

  // Cartazes do pacote de desenho. Para girar o catálogo do cliente, troque CARTAZES_DEMO por
  // uma busca em /api/publico (campo `vitrine`) — o carrossel aceita as duas listas igual.
  carrossel = carrosselEntrada(CARTAZES_DEMO);
  if (carrossel) cartazes.append(carrossel.elemento);
}

const RECADO_SENHA = 'A redefinição de senha por e-mail ainda não está ligada nesta instalação. '
  + 'Fale com o atendimento para liberar o acesso.';
const RECADO_AJUDA = 'Para suporte, fale com o atendimento da operadora. '
  + 'Se você já é assinante e perdeu o acesso, tenha em mãos o e-mail do cadastro.';

const itemPlano = (texto) => el('li', {}, icone('certo'), texto);

/** Vitrine de planos (usada quando falta assinatura e em Minha conta). */
export function telaPlanos(raiz, { assinatura, aoAssinar, aoVoltar, titulo = 'Escolha seu plano', aviso = null }) {
  let escolhido = assinatura?.plano?.id ?? null;
  const lista = el('div', { class: 'planos' });
  const rodape = el('div', { class: 'linha fim', style: 'margin-top:18px' });

  const desenhar = (planos, atual) => {
    limpar(lista, planos.map((p) => {
      const cartao = el('button', { class: `plano${escolhido === p.id ? ' on' : ''}`, type: 'button' },
        el('div', { class: 'linha entre' },
          el('strong', { style: 'font-size:17px' }, p.nome),
          atual === p.id ? el('span', { class: 'etiqueta ok atual' }, 'seu plano') : null),
        el('div', { class: 'preco' }, dinheiro(p.preco_centavos), el('small', {}, p.periodicidade === 'anual' ? ' /ano' : ' /mês')),
        p.descricao ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, p.descricao) : null,
        el('ul', {},
          itemPlano(`${p.telas} ${p.telas > 1 ? 'telas ao mesmo tempo' : 'tela por vez'}`),
          itemPlano(`Qualidade ${QUALIDADES[p.qualidade] ?? p.qualidade}`),
          itemPlano(`${p.perfis_max} perfis de visualização`),
          itemPlano(p.canais_ao_vivo ? 'Todos os canais ao vivo' : 'Catálogo sob demanda'),
          p.downloads ? itemPlano('Downloads para assistir sem internet') : null));
      cartao.addEventListener('click', () => { escolhido = p.id; desenhar(planos, atual); });
      return cartao;
    }));
    limpar(rodape,
      aoVoltar ? el('button', { class: 'btn vazio', onclick: aoVoltar }, 'Voltar') : null,
      (() => {
        const b = el('button', { class: 'btn primario grande', disabled: !escolhido || escolhido === atual },
          atual ? 'Trocar de plano' : 'Assinar e pagar com PIX');
        b.addEventListener('click', () => acao(b, async () => {
          const r = atual ? await api.post('/conta/trocar-plano', { plano_id: escolhido }) : await api.post('/conta/assinar', { plano_id: escolhido });
          aoAssinar(r);
        }));
        return b;
      })());
  };

  // Quem ainda não assinou para nesta tela: daqui ele precisa conseguir sair e, se quiser,
  // apagar a conta — é o que a App Store confere na revisão.
  const conta = el('div', { class: 'linha', style: 'margin-top:20px;gap:10px;justify-content:center;flex-wrap:wrap' },
    el('button', { class: 'btn pequeno vazio', onclick: () => { sessao.limpar(); window.dispatchEvent(new CustomEvent('tv:sair')); } }, 'Sair da conta'),
    botaoExcluirConta({ classe: 'btn pequeno vazio perigo' }));

  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'caixa larga' },
    marca(),
    el('h1', { style: 'margin:18px 0 6px' }, titulo),
    el('p', { class: 'mudo', style: 'margin:0 0 18px' }, aviso ?? 'Todos os planos dão acesso aos canais ao vivo e ao catálogo completo. Cancele quando quiser.'),
    lista, rodape, aoVoltar ? null : conta)));

  api.get('/conta/planos').then((r) => {
    escolhido = escolhido ?? r.planos[Math.min(1, r.planos.length - 1)]?.id ?? null;
    desenhar(r.planos, r.atual);
  }).catch((err) => toast(err.message, true));
}

/** Pagamento por PIX da fatura em aberto. */
export function telaPagamento(raiz, { fatura, pagamentos, aoPagar, aoVoltar }) {
  const qr = el('div', { class: 'qr' }, el('p', { class: 'pequeno mudo centro' }, 'Gerando o QR Code…'));
  if (fatura?.pix_copia_cola) {
    api.get(`/conta/faturas/${fatura.id}/qr`).then((svg) => { qr.innerHTML = String(svg); }).catch(() => {
      limpar(qr, el('p', { class: 'pequeno centro', style: 'color:#333' }, 'Use o código copia e cola ao lado.'));
    });
  }
  const botaoPagar = el('button', { class: 'btn primario grande bloco' }, 'Já paguei, liberar acesso');
  botaoPagar.addEventListener('click', () => acao(botaoPagar, async () => {
    await api.post(`/conta/faturas/${fatura.id}/pagar`, {});
    toast('Pagamento confirmado. Boa sessão!');
    aoPagar();
  }));

  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'caixa larga' },
    marca(),
    el('h1', { style: 'margin:18px 0 6px' }, 'Pague com PIX para liberar'),
    el('p', { class: 'mudo', style: 'margin:0 0 18px' }, `${fatura.descricao} · ${dinheiro(fatura.valor_centavos)} · vence em ${new Date(`${fatura.vencimento}T12:00:00`).toLocaleDateString('pt-BR')}`),
    fatura.pix_copia_cola
      ? el('div', { class: 'pix-caixa' }, qr, el('div', { class: 'coluna' },
        el('div', {}, el('strong', {}, 'PIX copia e cola'), el('div', { class: 'copiavel', onclick: (e) => { navigator.clipboard?.writeText(fatura.pix_copia_cola); e.currentTarget.style.borderColor = '#22C58B'; toast('Código copiado!'); } }, fatura.pix_copia_cola)),
        el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Abra o app do seu banco, escolha PIX, use "copia e cola" ou leia o QR Code.'),
        pagamentos === 'simulado' ? botaoPagar : el('div', { class: 'aviso atencao' }, 'Assim que o PIX cair, a liberação é automática. Guarde o comprovante.')))
      : el('div', { class: 'coluna' },
        el('div', { class: 'aviso atencao' }, 'A chave PIX da plataforma ainda não foi cadastrada pela operação. Fale com o atendimento para pagar.'),
        pagamentos === 'simulado' ? botaoPagar : null),
    el('div', { class: 'linha fim', style: 'margin-top:18px' }, el('button', { class: 'btn vazio', onclick: aoVoltar }, 'Voltar')))));
}
