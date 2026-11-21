import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, lerForm, campo, formModal, repetir, PERFIS } from './ui.js';
import { TELAS_EQUIPE } from './painel.js';
import { TELAS_ANUNCIANTE, TELAS_LOJISTA } from './portais.js';

const raiz = $('#app');
let pararTela = null;
let pararSaude = null;
let nomePlataforma = 'Vai Mídia';
let slogan = 'Sua marca em movimento.';

// [rota, rótulo, ícone, perfis que veem (vazio = todos do grupo)]
const MENUS = {
  equipe: [
    ['resumo', 'Visão geral', 'dashboard'], ['telas', 'TVs', 'telas'], ['pontos', 'Pontos', 'pontos'],
    ['comunicados', 'Comunicados', 'aprovacoes'],
    ['anunciantes', 'Anunciantes e agências', 'anunciantes'], ['campanhas', 'Campanhas', 'campanhas'], ['criativos', 'Criativos', 'midias'],
    ['programacao', 'Programação', 'grade'], ['inventario', 'Inventário', 'ocupacao'],
    ['relatorios', 'Relatórios', 'relatorios'], ['faturamento', 'Faturamento', 'faturamento'],
    ['repasses', 'Repasses aos pontos', 'repasses'], ['diagnostico', 'Diagnóstico', 'diagnostico'],
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
  pontos: 'Condomínios, prédios e comércios onde as TVs estão instaladas',
  comunicados: 'Recados do próprio ponto que entram entre os anúncios',
  anunciantes: 'Quem paga pela publicidade e as agências que compram a mídia',
  inventario: 'O que a rede tem para vender: circuitos, pontos, telas e audiência', campanhas: 'O que vai ao ar, onde, quando e por quanto',
  criativos: 'Imagens e vídeos que vão para as telas', programacao: 'Como fica o loop de cada TV e quanto ainda cabe de publicidade',
  relatorios: 'Inserções, impactos e a prova de exibição', faturamento: 'Fechamento do mês e faturas dos anunciantes',
  repasses: 'Comissão dos lojistas sobre a receita das telas', diagnostico: 'Verificações da rede e das TVs',
  usuarios: 'Quem acessa o painel e os portais', configuracoes: 'Regras da programação, preços de tabela e PIX das faturas',
  historico: 'Registro de quem fez o quê', prova: 'Cada vez que seu anúncio foi ao ar', faturas: 'Suas faturas e o PIX para pagamento',
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
  const item = menu.find(([k, , , perfis]) => k === nome && (!perfis || perfis.includes(u.perfil)));
  if (!item || !telas[nome]) return ir(menu[0][0]);

  const conteudo = el('main', { class: 'conteudo' });
  let recolhida = false;
  try { recolhida = localStorage.getItem('midia.menu') === 'recolhido'; } catch { /* padrão */ }
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}` });

  const itens = menu.filter(([, , , perfis]) => !perfis || perfis.includes(u.perfil))
    .map(([k, rotulo, ic]) => el('a', { class: `item${k === nome ? ' on' : ''}`, href: `#/${k}`, title: rotulo }, icone(ic), el('span', { class: 'rotulo' }, rotulo)));

  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('midia.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta'))),
    itens);

  const subtitulo = SUBTITULOS[nome] ? el('p', { class: 'subtitulo' }, SUBTITULOS[nome]) : null;
  const vinculo = u.anunciante_nome ?? u.local_nome ?? null;
  const topo = el('header', { class: 'topo' },
    el('div', {}, vinculo ? el('div', { class: 'trilha' }, vinculo) : null, el('h1', { style: 'margin:0' }, item[1]), subtitulo),
    ferramentas(u));
  casca.append(lateral, el('div', { class: 'principal' }, topo, conteudo));
  limpar(raiz, casca);
  document.title = `${item[1]} · ${nomePlataforma}`;

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

function telaEntrada() {
  const f = el('form', { class: 'form' },
    campo('E-mail', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
    campo('Senha', { name: 'senha', type: 'password', autocomplete: 'current-password', required: true }),
    el('button', { class: 'btn primario', style: 'min-height:42px;margin-top:4px' }, 'Entrar'));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button'), async () => {
      const r = await api.post('/auth/login', lerForm(f));
      sessao.set(r);
      location.hash = '';
      desenhar();
    });
  });
  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'cartao' },
    marca(nomePlataforma),
    slogan ? el('p', { class: 'slogan-marca' }, slogan) : null,
    el('h1', { style: 'margin:22px 0 4px;font-size:20px' }, 'Entrar no painel'),
    el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'Equipe, anunciantes e responsáveis pelos pontos entram por aqui.'), f,
    el('div', { class: 'linha entre', style: 'margin-top:14px' },
      el('button', { type: 'button', class: 'btn pequeno', style: 'border:0;background:none;padding:0', onclick: esqueciSenha }, 'Esqueci minha senha'),
      el('span', { class: 'pequeno mudo' }, 'Instalando uma tela? Abra ', el('a', { href: 'tv/' }, 'o player'), ' no aparelho.')))));
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
    campo('Nova senha (mínimo 8 caracteres)', { name: 'senha', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
    campo('Repita a nova senha', { name: 'repetir', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
    el('button', { class: 'btn primario', style: 'min-height:42px;margin-top:4px' }, 'Salvar e entrar'));
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
  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'cartao' },
    marca(nomePlataforma),
    slogan ? el('p', { class: 'slogan-marca' }, slogan) : null,
    el('h1', { style: 'margin:22px 0 4px;font-size:20px' }, 'Criar uma nova senha'),
    el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'O link do e-mail vale por uma hora e só funciona uma vez.'), f)));
  f.querySelector('input').focus();
}

api.get('/publico').then((p) => {
  nomePlataforma = p.nome || 'Vai Mídia';
  slogan = p.slogan ?? '';
}).catch(() => {}).finally(desenhar);
