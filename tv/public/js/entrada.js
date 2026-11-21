import { api, sessao, perfil as perfilGuardado } from './api.js';
import { el, marca, lerForm, acao, toast, icone, dinheiro, QUALIDADES, limpar } from './ui.js';
import { botaoExcluirConta } from './excluir-conta.js';

const campo = (rotulo, attrs) => el('label', { class: 'campo' }, rotulo, el('input', attrs));

/** Tela de entrada: login e criação de conta. */
export function telaEntrada(raiz, { aoEntrar }) {
  let modo = 'entrar';
  const corpo = el('div');
  const chaves = el('div', { class: 'chaves', role: 'tablist' });

  const concluir = (r) => {
    sessao.set({ token: r.token, usuario: r.usuario });
    perfilGuardado.limpar();
    aoEntrar(r);
  };

  const formEntrar = () => {
    const f = el('form', { class: 'form' },
      campo('E-mail', { name: 'email', type: 'email', autocomplete: 'username', required: true, placeholder: 'voce@email.com' }),
      campo('Senha', { name: 'senha', type: 'password', autocomplete: 'current-password', required: true }),
      el('button', { class: 'btn primario grande bloco' }, 'Entrar'));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(f.querySelector('button'), async () => concluir(await api.post('/auth/login', lerForm(f))));
    });
    return f;
  };

  const formCadastro = () => {
    const f = el('form', { class: 'form' },
      campo('Nome completo', { name: 'nome', required: true, autocomplete: 'name', maxlength: 120 }),
      campo('E-mail', { name: 'email', type: 'email', required: true, autocomplete: 'email' }),
      campo('Celular com DDD (opcional)', { name: 'telefone', type: 'tel', autocomplete: 'tel', placeholder: '(11) 99999-0000' }),
      campo('Senha (mínimo 8 caracteres)', { name: 'senha', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Depois de criar a conta você escolhe o plano. Sem assinatura ativa, o conteúdo fica bloqueado.'),
      el('button', { class: 'btn primario grande bloco' }, 'Criar minha conta'));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = lerForm(f);
      if (!d.telefone) delete d.telefone;
      acao(f.querySelector('button'), async () => {
        concluir(await api.post('/auth/cadastro', d));
        toast('Conta criada! Escolha seu plano.');
      });
    });
    return f;
  };

  const desenhar = () => {
    limpar(chaves,
      el('button', { class: modo === 'entrar' ? 'on' : '', type: 'button', onclick: () => { modo = 'entrar'; desenhar(); } }, 'Entrar'),
      el('button', { class: modo === 'cadastro' ? 'on' : '', type: 'button', onclick: () => { modo = 'cadastro'; desenhar(); } }, 'Criar conta'));
    limpar(corpo, modo === 'entrar' ? formEntrar() : formCadastro());
  };
  desenhar();

  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'caixa' },
    marca(),
    el('h1', { style: 'margin:18px 0 4px' }, modo === 'entrar' ? 'Sua TV, onde você estiver' : 'Comece agora'),
    el('p', { class: 'mudo', style: 'margin:0' }, 'Canais de TV ao vivo, filmes e séries num só lugar.'),
    chaves, corpo)));
}

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
