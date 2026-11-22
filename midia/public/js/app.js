import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, lerForm, campo, marcar, formModal, repetir, linkWhatsApp, PERFIS } from './ui.js';
import { TELAS_EQUIPE } from './painel.js';
import { TELAS_ANUNCIANTE, TELAS_LOJISTA } from './portais.js';

const raiz = $('#app');
let pararTela = null;
let pararSaude = null;
let nomePlataforma = 'Vai Mídia';
let slogan = 'Sua marca em movimento.';
// WhatsApp da empresa: vira o botão "Falar com a equipe" nos portais do anunciante e do ponto.
let whatsappEquipe = '';

// [rota, rótulo, ícone, perfis que veem (vazio = todos do grupo)]
const MENUS = {
  equipe: [
    ['resumo', 'Visão geral', 'dashboard'], ['telas', 'TVs', 'telas'], ['pontos', 'Pontos', 'pontos'],
    ['comunicados', 'Comunicados', 'aprovacoes'],
    ['anunciantes', 'Anunciantes e agências', 'anunciantes'], ['campanhas', 'Campanhas', 'campanhas'], ['criativos', 'Criativos', 'midias'],
    ['programacao', 'Programação', 'grade'], ['inventario', 'Inventário', 'ocupacao'],
    ['crm', 'CRM', 'anunciantes', null, [
      ['funil', 'Funil'], ['propostas', 'Propostas'], ['emails', 'E-mail'],
    ]],
    ['relatorios', 'Relatórios', 'relatorios'],
    ['financeiro', 'Financeiro', 'faturamento', null, [
      ['caixa', 'Fluxo de caixa'], ['receber', 'Contas a receber'], ['pagar', 'Contas a pagar'], ['faturamento', 'Faturamento'],
    ]],
    ['diagnostico', 'Diagnóstico', 'diagnostico'],
    ['usuarios', 'Usuários', 'usuarios', ['master']], ['configuracoes', 'Configurações', 'configuracoes', ['master']],
    ['historico', 'Histórico', 'historico'],
  ],
  anunciante: [
    ['resumo', 'Minhas campanhas', 'dashboard'], ['campanhas', 'Campanhas', 'campanhas'], ['criativos', 'Meus criativos', 'midias'],
    ['prova', 'Prova de exibição', 'relatorios'], ['faturas', 'Faturas', 'faturamento'], ['rede', 'Onde meus anúncios passam', 'rede'],
  ],
  lojista: [
    ['resumo', 'Minhas TVs', 'telas'], ['comunicados', 'Comunicados', 'aprovacoes'], ['conteudo', 'Conteúdo próprio', 'midias'],
    ['repasses', 'Meu repasse', 'dinheiro'], ['relatorios', 'Exibições', 'relatorios'],
  ],
};

const SUBTITULOS = {
  resumo: 'O que está acontecendo na rede agora', telas: 'Aparelhos instalados, estado e programação de cada um',
  pontos: 'Condomínios, prédios, comércios, academias e clínicas onde as TVs estão instaladas',
  comunicados: 'Recados do próprio ponto que entram entre os anúncios',
  anunciantes: 'Quem paga pela publicidade e as agências que compram a mídia',
  inventario: 'O que a rede tem para vender: circuitos, pontos, telas e audiência', campanhas: 'O que vai ao ar, onde, quando e por quanto',
  criativos: 'Imagens e vídeos que vão para as telas', programacao: 'Como fica o loop de cada TV e quanto ainda cabe de publicidade',
  relatorios: 'Inserções, impactos e a prova de exibição', faturamento: 'Fechamento do mês e faturas dos anunciantes',
  repasses: 'Comissão dos lojistas sobre a receita das telas', diagnostico: 'Verificações da rede e das TVs',
  usuarios: 'Quem acessa o painel e os portais', configuracoes: 'Regras da programação, preços de tabela e PIX das faturas',
  receber: 'Faturas dos anunciantes: o que entra, o que está vencendo e o que atrasou',
  pagar: 'Repasses aos pontos e despesas da operação: o que sai',
  funil: 'O funil: com quem estamos falando, o que ficou combinado e o que virou contrato',
  propostas: 'O papel que sai do funil e volta como contrato',
  emails: 'A conversa por e-mail com quem está no funil, do lado de dentro do sistema',
  historico: 'Registro de quem fez o quê', prova: 'Cada vez que seu anúncio foi ao ar', faturas: 'Seu contrato, as faturas e o PIX para pagamento',
  rede: 'Pontos e telas onde a publicidade pode passar', conteudo: 'Imagens e vídeos do seu ponto na TV', conta: 'Sua conta',
};

const grupo = (perfil) => (['master', 'operador'].includes(perfil) ? 'equipe' : perfil);

window.addEventListener('midia:sair', () => desenhar());
window.addEventListener('hashchange', () => desenhar());
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-usuario, .usuario')) document.querySelector('.menu-usuario')?.classList.add('oculto'); });

const rota = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
const ir = (tela) => { location.hash = `#/${tela}`; };

async function desenhar() {
  pararTela?.();
  pararTela = null;
  // Link de nova senha, vindo do e-mail: vale mesmo sem sessão.
  const [primeiro, codigo] = rota();
  if (primeiro === 'nova-senha' && codigo) { pararSaude?.(); pararSaude = null; return telaNovaSenha(codigo); }
  const s = sessao.get();
  if (!s?.token) { pararSaude?.(); pararSaude = null; return telaEntrada(); }
  const u = s.usuario;
  const g = grupo(u.perfil);
  const menu = MENUS[g];
  const telas = { equipe: TELAS_EQUIPE, anunciante: TELAS_ANUNCIANTE, lojista: TELAS_LOJISTA }[g];
  const [nome, ...resto] = rota();
  const item = menu.find(([k, , , perfis, subs]) => (k === nome || subs?.some(([sk]) => sk === nome)) && (!perfis || perfis.includes(u.perfil)));
  // Um grupo (só submenus) leva para a primeira tela dele.
  if (item?.[4] && item[0] === nome && item[4][0][0] !== nome) return ir(item[4][0][0]);
  if (!item || !telas[nome]) return ir(menu[0][4]?.[0][0] ?? menu[0][0]);

  const conteudo = el('main', { class: 'conteudo' });
  let recolhida = false;
  try { recolhida = localStorage.getItem('midia.menu') === 'recolhido'; } catch { /* padrão */ }
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}` });

  const itens = menu.filter(([, , , perfis]) => !perfis || perfis.includes(u.perfil)).map(([k, rotulo, ic, , subs]) => {
    const aberto = k === nome || subs?.some(([sk]) => sk === nome);
    const link = el('a', { class: `item${aberto ? ' on' : ''}`, href: `#/${subs ? subs[0][0] : k}`, title: rotulo }, icone(ic), el('span', { class: 'rotulo' }, rotulo));
    if (!subs || !aberto) return link;
    return [link, el('div', { class: 'grupo-sub' }, subs.map(([sk, sr]) => el('a', { class: `sub${sk === nome ? ' on' : ''}`, href: `#/${sk}` }, sr)))];
  });

  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('midia.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta'))),
    itens,
    // Quem está no portal não tem com quem falar dentro do sistema: este botão resolve isso.
    whatsappEquipe && u.perfil !== 'master' && u.perfil !== 'operador'
      ? el('a', {
        class: 'falar-equipe', target: '_blank', rel: 'noopener',
        href: linkWhatsApp(whatsappEquipe, `Olá! Sou ${u.anunciante_nome ?? u.local_nome ?? u.nome} e queria falar com a equipe.`),
      }, icone('enviar'), el('span', { class: 'rotulo' }, 'Falar com a equipe'))
      : null);

  const subtitulo = SUBTITULOS[nome] ? el('p', { class: 'subtitulo' }, SUBTITULOS[nome]) : null;
  const vinculo = u.anunciante_nome ?? u.local_nome ?? null;
  // Dentro de um grupo, o título é o da tela e a trilha mostra de onde ela vem.
  const dentroDeGrupo = item[4] && item[0] !== nome;
  const tituloTela = dentroDeGrupo ? item[4].find(([sk]) => sk === nome)[1] : item[1];
  const topo = el('header', { class: 'topo' },
    el('div', {},
      dentroDeGrupo ? el('div', { class: 'trilha' }, item[1]) : (vinculo ? el('div', { class: 'trilha' }, vinculo) : null),
      el('h1', { style: 'margin:0' }, tituloTela), subtitulo),
    ferramentas(u));
  casca.append(lateral, el('div', { class: 'principal' }, topo, conteudo));
  // A tela inteira é redesenhada a cada troca. Sem guardar onde o menu estava, ele volta para o
  // começo e quem tem muitos itens perde a referência do que acabou de clicar.
  const rolagemMenu = $('.lateral')?.scrollTop ?? 0;
  limpar(raiz, casca);
  lateral.scrollTop = rolagemMenu;
  // Se o item aberto ficou fora da vista (menu longo, tela baixa), ele é trazido para o meio.
  const ativo = lateral.querySelector('a.item.on');
  if (ativo && (ativo.offsetTop < lateral.scrollTop || ativo.offsetTop + ativo.offsetHeight > lateral.scrollTop + lateral.clientHeight)) {
    lateral.scrollTop = Math.max(0, ativo.offsetTop - lateral.clientHeight / 2);
  }
  // E a tela nova começa do alto, não no meio da rolagem da tela anterior.
  window.scrollTo({ top: 0 });
  document.title = `${tituloTela} · ${nomePlataforma}`;

  const ctx = {
    usuario: u,
    conteudo,
    master: u.perfil === 'master',
    equipe: g === 'equipe',
    parametros: resto,
    parar: (fn) => { pararTela = fn; },
    ir,
  };
  try {
    await telas[nome](ctx);
  } catch (err) {
    limpar(conteudo, el('p', { class: 'aviso erro' }, err.message));
  }
}

function ferramentas(u) {
  const tema = document.documentElement.dataset.tema || 'claro';
  const trocar = (t) => {
    document.documentElement.dataset.tema = t;
    try { localStorage.setItem('midia.tema', t); } catch { /* ignora */ }
    for (const b of document.querySelectorAll('[data-tema-btn]')) b.classList.toggle('on', b.dataset.temaBtn === t);
  };
  const menu = el('div', { class: 'menu-usuario oculto' },
    el('div', { class: 'quem' }, el('strong', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email), el('div', { class: 'pequeno mudo' }, PERFIS[u.perfil])),
    el('button', { onclick: () => { menu.classList.add('oculto'); alterarSenha(); } }, 'Alterar senha'),
    el('button', { onclick: () => { sessao.limpar(); location.hash = ''; desenhar(); } }, 'Sair'));
  const status = el('span', { class: 'status-sistema', title: 'Conexão com o servidor' }, 'Sistema Online');
  pararSaude?.();
  pararSaude = repetir(async () => {
    try {
      await api.get('/saude');
      status.className = 'status-sistema';
      status.textContent = 'Sistema Online';
    } catch {
      status.className = 'status-sistema erro';
      status.textContent = 'Sem conexão';
    }
  }, 30_000);
  return el('div', { class: 'ferramentas' }, status,
    el('button', { class: tema === 'claro' ? 'on' : '', title: 'Tema claro', dataset: { temaBtn: 'claro' }, onclick: () => trocar('claro') }, icone('sol')),
    el('button', { class: tema === 'escuro' ? 'on' : '', title: 'Tema escuro', dataset: { temaBtn: 'escuro' }, onclick: () => trocar('escuro') }, icone('lua')),
    el('button', { class: 'usuario', title: u.nome, onclick: () => menu.classList.toggle('oculto') },
      el('span', { class: 'avatar' }, iniciais(u.nome)), el('span', { class: 'nome' }, u.nome), icone('abaixo')),
    menu);
}

function alterarSenha() {
  formModal('Alterar senha', () => [
    campo('Senha atual', { name: 'atual', type: 'password', required: true, autocomplete: 'current-password' }),
    campo('Nova senha (mínimo 8 caracteres)', { name: 'nova', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
  ], async (d) => {
    await api.post('/auth/senha', d);
    toast('Senha alterada.');
  });
}

/**
 * A casca das telas de entrada: a fotografia da rede ocupando a janela e o cartão de vidro por cima.
 * Vale para o login e para a criação de senha nova, para as duas serem a mesma casa.
 */
function cascaDeEntrada(...dentro) {
  return el('div', { class: 'entrada' },
    el('div', { class: 'cartao' },
      marca(nomePlataforma),
      ...dentro.flat(Infinity).filter(Boolean)),
    slogan ? el('p', { class: 'assinatura' }, slogan) : null);
}

/** O olho que mostra a senha digitada: evita a terceira tentativa errada por causa do teclado. */
function campoSenha(rotulo, attrs) {
  const entrada = el('input', { type: 'password', ...attrs });
  const botao = el('button', {
    type: 'button', class: 'ver-senha', 'aria-pressed': 'false', 'aria-label': 'Mostrar senha', title: 'Mostrar senha',
    onclick: () => {
      const mostrando = entrada.type === 'text';
      entrada.type = mostrando ? 'password' : 'text';
      botao.setAttribute('aria-pressed', String(!mostrando));
      botao.setAttribute('aria-label', mostrando ? 'Mostrar senha' : 'Esconder senha');
      entrada.focus();
    },
  }, el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    el('path', { d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z' }),
    el('circle', { cx: '12', cy: '12', r: '3' }),
    el('path', { class: 'corte', d: 'm4 4 16 16' })));
  return el('label', { class: 'campo senha-campo' }, rotulo, entrada, botao);
}

function telaEntrada() {
  const lembradoAntes = Boolean(sessao.emailLembrado());
  const f = el('form', { class: 'form' },
    campo('E-mail', {
      name: 'email', type: 'email', autocomplete: 'username', required: true,
      placeholder: 'seuemail@empresa.com.br', value: sessao.emailLembrado(),
    }),
    campoSenha('Senha', { name: 'senha', autocomplete: 'current-password', required: true, placeholder: '••••••' }),
    el('div', { class: 'opcoes' },
      marcar('Lembrar de mim', { name: 'lembrar', checked: lembradoAntes }),
      el('button', { type: 'button', class: 'link-texto', onclick: esqueciSenha }, 'Esqueci minha senha')),
    el('button', { class: 'btn primario' }, 'Entrar'));

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button.primario'), async () => {
      const d = lerForm(f);
      const r = await api.post('/auth/login', { email: d.email, senha: d.senha });
      // Marcou "lembrar": a sessão sobrevive a fechar o navegador e o e-mail volta preenchido.
      sessao.set(r, { lembrar: d.lembrar });
      sessao.lembrarEmail(d.lembrar ? d.email : '');
      location.hash = '';
      desenhar();
    });
  });

  limpar(raiz, cascaDeEntrada(
    el('h1', {}, 'Bem-vindo'),
    el('p', { class: 'abertura' }, 'Acesse sua conta.'),
    f,
    el('div', { class: 'ir-player' },
      el('a', { href: 'tv/' }, 'Acessar player'),
      el('p', { class: 'pequeno mudo', style: 'margin:8px 0 0' }, 'Para o aparelho ligado à TV.'))));
  f.querySelector('input').focus();
}

/** Pede o link de nova senha (a resposta é a mesma exista ou não a conta). */
const esqueciSenha = () => formModal('Esqueci minha senha', () => [
  el('p', { class: 'mudo', style: 'margin:0' }, 'Informe o e-mail da sua conta. Se existir, chega um link para criar uma senha nova.'),
  campo('E-mail', { name: 'email', type: 'email', required: true, autocomplete: 'username' }),
], async (d) => {
  const r = await api.post('/auth/recuperar', d);
  toast(r.aviso);
}, { rotulo: 'Enviar o link' });

/** Tela aberta pelo link do e-mail. */
function telaNovaSenha(codigo) {
  const f = el('form', { class: 'form' },
    campoSenha('Nova senha (mínimo 8 caracteres)', { name: 'senha', required: true, minlength: 8, autocomplete: 'new-password' }),
    campoSenha('Repita a nova senha', { name: 'repetir', required: true, minlength: 8, autocomplete: 'new-password' }),
    el('button', { class: 'btn primario' }, 'Salvar e entrar'));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button'), async () => {
      const d = lerForm(f);
      if (d.senha !== d.repetir) throw new Error('As duas senhas precisam ser iguais.');
      const r = await api.post('/auth/nova-senha', { codigo, senha: d.senha });
      const entrada = await api.post('/auth/login', { email: r.email, senha: d.senha });
      sessao.set(entrada);
      location.hash = '';
      toast('Senha trocada.');
      desenhar();
    });
  });
  limpar(raiz, cascaDeEntrada(
    el('h1', {}, 'Nova senha'),
    el('p', { class: 'abertura' }, 'O link do e-mail vale por uma hora e só funciona uma vez.'), f));
  f.querySelector('input').focus();
}

api.get('/publico').then((p) => {
  nomePlataforma = p.nome || 'Vai Mídia';
  slogan = p.slogan ?? '';
  whatsappEquipe = p.whatsapp ?? '';
}).catch(() => {}).finally(desenhar);
