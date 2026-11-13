import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, lerForm, campo, formModal, repetir, PERFIS } from './ui.js';
import { TELAS_MASTER } from './master.js';
import { TELAS_EMPRESA } from './empresa.js';

const raiz = $('#app');
let pararTela = null;
let nomePlataforma = 'ZOE Atende';
const nomesEmpresa = new Map();

const PLATAFORMA = ['master', 'suporte'];

// [rota, rótulo, ícone, perfis que veem (vazio = todos)]
const MENU_MASTER = [
  ['dashboard', 'Dashboard', 'dashboard'], ['empresas', 'Empresas', 'empresas'], ['relatorios', 'Relatórios', 'relatorios'],
  ['usuarios', 'Usuários', 'equipe', ['master']], ['seguranca', 'Segurança', 'seguranca', ['master']],
  ['diagnostico', 'Diagnóstico', 'diagnostico'], ['configuracoes', 'Configurações', 'configuracoes', ['master']],
];
const MENU_EMPRESA = [
  ['caixa', 'Atendimentos', 'caixa'],
  ['dashboard', 'Dashboard', 'dashboard'],
  ['ia', 'ZOE', 'ia'],
  ['ouvidoria', 'Ouvidoria', 'alerta'],
  ['contatos', 'Contatos', 'contatos'],
  ['chamados', 'Chamados', 'chamados'],
  ['filas', 'Filas', 'filas', ['master', 'suporte', 'cliente', 'supervisor']],
  ['equipe', 'Equipe', 'equipe', ['master', 'suporte', 'cliente', 'supervisor']],
  ['relatorios', 'Relatórios', 'relatorios', ['master', 'suporte', 'cliente', 'supervisor']],
  ['configuracoes', 'Configurações', 'configuracoes', ['master', 'suporte', 'cliente', 'supervisor']],
  ['integracoes', 'Integrações', 'integracoes', ['master', 'suporte', 'cliente']],
];

const SUBTITULOS = {
  caixa: 'A ZOE resolve o que dá; aqui fica o que precisa de gente',
  dashboard: 'Como está o atendimento agora e no mês',
  ia: 'O que ela sabe, o que ela faz e quando ela chama a equipe',
  ouvidoria: 'Reclamação, cancelamento, Procon e Anatel — com protocolo, prazo e desfecho',
  contatos: 'Quem já falou com a sua empresa pelo WhatsApp',
  chamados: 'Pedidos registrados que não tinham solução na hora',
  filas: 'Os departamentos que recebem o que a ZOE não resolve',
  equipe: 'Quem atende, com qual perfil e quantas conversas ao mesmo tempo',
  relatorios: 'Quanto a ZOE resolve e onde a equipe é necessária',
  configuracoes: 'Número de WhatsApp, respostas rápidas e etiquetas',
  integracoes: 'Chaves de API para o seu sistema conversar com a plataforma',
  empresas: 'Empresas clientes da plataforma',
  usuarios: 'Quem acessa a plataforma e com qual perfil',
  seguranca: 'Acessos recusados, IPs bloqueados e o registro de atividades',
  diagnostico: 'Verificações da plataforma e a conexão de cada número com a Meta',
};

let pararSaude = null;

window.addEventListener('atend:sair', () => desenhar());
window.addEventListener('hashchange', () => desenhar());
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-usuario, .usuario')) document.querySelector('.menu-usuario')?.classList.add('oculto'); });

/** Rota atual: { empresaId, tela } a partir de #/tela ou #/empresa/ID/tela. */
function rota() {
  const partes = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  if (partes[0] === 'empresa' && /^\d+$/.test(partes[1] ?? '')) return { empresaId: Number(partes[1]), tela: partes[2] || 'caixa' };
  return { empresaId: null, tela: partes[0] || 'dashboard' };
}
const link = (empresaId, tela) => (empresaId ? `#/empresa/${empresaId}/${tela}` : `#/${tela}`);
const ir = (empresaId, tela) => { location.hash = link(empresaId, tela); };

async function desenhar() {
  pararTela?.();
  pararTela = null;
  const s = sessao.get();
  if (!s?.token) { pararSaude?.(); pararSaude = null; return telaEntrada(); }
  const u = s.usuario;
  let { empresaId, tela } = rota();
  // Usuário de empresa fica sempre no painel da própria empresa.
  if (!PLATAFORMA.includes(u.perfil) && empresaId !== u.empresa_id) {
    history.replaceState(null, '', link(u.empresa_id, empresaId ? tela : 'caixa'));
    ({ empresaId, tela } = rota());
  }
  const menu = empresaId ? MENU_EMPRESA : MENU_MASTER;
  const telas = empresaId ? TELAS_EMPRESA : TELAS_MASTER;
  const item = menu.find(([k, , , perfis]) => k === tela && (!perfis || perfis.includes(u.perfil)));
  if (!item || !telas[tela]) return ir(empresaId, empresaId ? 'caixa' : 'dashboard');

  let nomeEmpresa = null;
  if (empresaId) {
    nomeEmpresa = nomesEmpresa.get(empresaId);
    if (!nomeEmpresa) {
      try {
        nomeEmpresa = (await api.get(`/empresas/${empresaId}`)).nome;
        nomesEmpresa.set(empresaId, nomeEmpresa);
      } catch (err) {
        toast(err.message, true);
        return PLATAFORMA.includes(u.perfil) ? ir(null, 'empresas') : undefined;
      }
    }
  }

  const conteudo = el('main', { class: `conteudo${tela === 'caixa' ? ' cheio' : ''}` });
  let recolhida = false;
  try { recolhida = localStorage.getItem('atend.menu') === 'recolhido'; } catch { /* padrão */ }
  // `cheia`: a tela ocupa a altura da janela e rola por dentro (caixa de entrada), em vez de alongar a página.
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}${tela === 'caixa' ? ' cheia' : ''}` });

  const itens = menu.filter(([, , , perfis]) => !perfis || perfis.includes(u.perfil)).map(([k, rotulo, ic]) =>
    el('a', { class: `item${k === tela ? ' on' : ''}`, href: link(empresaId, k), title: rotulo }, icone(ic), el('span', { class: 'rotulo' }, rotulo)));

  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('atend.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta'))),
    itens,
    empresaId && PLATAFORMA.includes(u.perfil) ? el('a', { class: 'item voltar', href: '#/empresas', title: 'Voltar ao master' }, icone('entrar'), el('span', { class: 'rotulo' }, 'Voltar ao master')) : null);

  const trilha = el('div', { class: 'trilha' });
  if (empresaId && PLATAFORMA.includes(u.perfil)) trilha.append(el('a', { href: '#/empresas' }, 'Empresas'), el('span', { class: 'sep' }, '/'), el('a', { href: link(empresaId, 'caixa') }, nomeEmpresa));

  const topo = el('header', { class: 'topo' },
    el('div', {}, trilha, el('h1', { style: 'margin:0' }, item[1]), SUBTITULOS[tela] ? el('p', { class: 'subtitulo' }, SUBTITULOS[tela]) : null),
    ferramentas(u, empresaId));
  casca.append(lateral, el('div', { class: 'principal' }, topo, conteudo));
  limpar(raiz, casca);
  document.title = `${item[1]} · ${nomeEmpresa ? `${nomeEmpresa} · ` : ''}${nomePlataforma}`;

  const ctx = {
    usuario: u, empresaId, nomeEmpresa, conteudo,
    master: PLATAFORMA.includes(u.perfil),
    soMaster: u.perfil === 'master',
    // Quem administra a empresa: a equipe da plataforma e o administrador da empresa.
    soAdmin: PLATAFORMA.includes(u.perfil) || u.perfil === 'cliente',
    somenteLeitura: u.perfil === 'supervisor',
    parar: (fn) => { pararTela = fn; },
    ir: (tela2, eid = empresaId) => ir(eid, tela2),
    renomearEmpresa: (id, nome) => nomesEmpresa.set(id, nome),
  };
  try {
    await telas[tela](ctx);
  } catch (err) {
    toast(err.message, true);
    limpar(conteudo, el('p', { class: 'mudo' }, err.message));
  }
  return undefined;
}

function ferramentas(u, empresaId) {
  const tema = document.documentElement.dataset.tema || 'claro';
  const trocar = (t) => {
    document.documentElement.dataset.tema = t;
    try { localStorage.setItem('atend.tema', t); } catch { /* ignora */ }
    for (const b of document.querySelectorAll('[data-tema-btn]')) b.classList.toggle('on', b.dataset.temaBtn === t);
  };
  const menu = el('div', { class: 'menu-usuario oculto' },
    el('div', { class: 'quem' }, el('strong', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email), el('div', { class: 'pequeno mudo' }, PERFIS[u.perfil])),
    el('button', { onclick: () => { menu.classList.add('oculto'); alterarSenha(); } }, 'Alterar senha'),
    el('button', { onclick: () => { sessao.limpar(); nomesEmpresa.clear(); location.hash = ''; desenhar(); } }, 'Sair'));

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

  return el('div', { class: 'ferramentas' },
    // O atendente entra e sai da distribuição por aqui: é a primeira coisa que ele faz no dia.
    ['atendente', 'cliente'].includes(u.perfil) && empresaId ? botaoDisponivel(u) : null,
    status,
    el('button', { class: tema === 'claro' ? 'on' : '', title: 'Tema claro', dataset: { temaBtn: 'claro' }, onclick: () => trocar('claro') }, icone('sol')),
    el('button', { class: tema === 'escuro' ? 'on' : '', title: 'Tema escuro', dataset: { temaBtn: 'escuro' }, onclick: () => trocar('escuro') }, icone('lua')),
    el('button', { class: 'usuario', title: u.nome, onclick: () => menu.classList.toggle('oculto') }, el('span', { class: 'avatar' }, iniciais(u.nome)), el('span', { class: 'nome' }, u.nome), icone('abaixo')),
    menu);
}

/** Botão de disponibilidade: ligado, o atendente recebe conversas da fila. */
function botaoDisponivel(u) {
  const b = el('button', { class: `disponivel${u.disponivel ? ' on' : ''}`, title: 'Receber conversas da fila' },
    el('i'), el('span', {}, u.disponivel ? 'Disponível' : 'Indisponível'));
  b.addEventListener('click', () => acao(b, async () => {
    const r = await api.post('/auth/disponivel', { disponivel: !u.disponivel });
    u.disponivel = r.disponivel;
    const s = sessao.get();
    if (s) { s.usuario.disponivel = r.disponivel; sessao.set(s); }
    b.classList.toggle('on', r.disponivel);
    b.querySelector('span').textContent = r.disponivel ? 'Disponível' : 'Indisponível';
    toast(r.disponivel
      ? (r.recebidas ? `Você está disponível e recebeu ${r.recebidas} conversa(s) da fila.` : 'Você está disponível para receber conversas.')
      : 'Você saiu da distribuição de conversas.');
  }));
  return b;
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
      desenhar();
    });
  });
  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'cartao' },
    marca(nomePlataforma),
    el('h1', { style: 'margin:28px 0 4px;font-size:20px' }, 'Entrar no painel'),
    el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'Use o e-mail e a senha que você recebeu.'), f)));
  f.querySelector('input').focus();
}

api.get('/publico').then((p) => { nomePlataforma = p.nome || 'ZOE Atende'; }).catch(() => {}).finally(desenhar);
