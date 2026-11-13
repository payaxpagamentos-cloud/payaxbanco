import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, lerForm, campo, formModal, repetir, PERFIS } from './ui.js';
import { TELAS_MASTER } from './master.js';
import { TELAS_EMPRESA } from './empresa.js';
import { iniciarTelefone, pararTelefone } from './telefone.js';

const raiz = $('#app');
let pararTela = null;
let nomePlataforma = 'ZOE PABX Inteligente';
const nomesEmpresa = new Map();

const PLATAFORMA = ['master', 'suporte'];
// [rota, rótulo, ícone, perfis que veem (vazio = todos)]
const MENU_MASTER = [
  ['dashboard', 'Dashboard', 'dashboard'], ['empresas', 'Empresas', 'empresas'], ['chamadas', 'Chamadas', 'chamadas'],
  ['usuarios', 'Permissões e usuários', 'usuarios', ['master']], ['seguranca', 'Segurança', 'seguranca', ['master']], ['relatorios', 'Relatórios', 'relatorios'],
  ['terminacao', 'Terminação', 'terminacao', null, [['rotas', 'Rotas de saída'], ['dids', 'Números (DIDs)']]],
  ['diagnostico', 'Diagnóstico', 'diagnostico'], ['configuracoes', 'Configurações', 'configuracoes', ['master']],
  ['integracoes', 'Integrações', 'integracoes'],
];
const MENU_EMPRESA = [
  ['dashboard', 'Dashboard', 'dashboard', null, [['dashboard', 'Dashboard'], ['supervisao', 'Supervisão de campanhas']]],
  ['zoe', 'ZOE', 'zoe'],
  ['campanhas', 'Campanhas', 'campanhas'], ['chamadas', 'Chamadas', 'chamadas'], ['crm', 'CRM', 'crm'],
  // O PABX num grupo só: cada peça com o nome que o provedor usa, em vez de escondida em "Recursos".
  ['pabx', 'PABX', 'terminacao', null, [
    ['ramais', 'Ramais'], ['filas', 'Filas de atendimento'], ['uras', 'URA'],
    ['numeros', 'Números entrantes'], ['terminacao', 'Rota de saída'],
  ]],
  ['relatorios', 'Relatórios', 'relatorios'], ['configuracoes', 'Configurações', 'configuracoes'],
  ['integracoes', 'Integrações', 'integracoes', ['master', 'suporte', 'cliente']],
];

// Frase sob o título de cada tela.
const SUBTITULOS = {
  dashboard: 'Visão geral da telefonia', supervisao: 'Campanhas e agentes em tempo real', zoe: 'Atendente virtual ligada ao IXC',
  campanhas: 'Discador: listas, filas e andamento', ramais: 'Os ramais da empresa e quem fala em cada um', chamadas: 'Histórico de ligações com filtros e exportação',
  crm: 'Contatos e histórico de ligações', terminacao: 'Por onde saem as ligações, a tarifação e o consumo', numeros: 'Para onde vai cada número que recebe ligações',
  recursos: 'Filas de atendimento e URAs (menus de atendimento)',
  filas: 'Para onde a ligação vai quando precisa de uma pessoa', uras: 'O que o cliente ouve quando liga — e o que a ZOE já resolve antes da fila', relatorios: 'Acompanhe o desempenho da sua telefonia', configuracoes: 'Dados da empresa, plano e usuários',
  integracoes: 'Chaves de API para a central telefônica', empresas: 'Empresas clientes da plataforma', usuarios: 'Quem acessa o painel e com qual perfil',
  seguranca: 'Acessos recusados, IPs bloqueados e atividades', diagnostico: 'Verificações da plataforma e das rotas',
};
let pararSaude = null;

window.addEventListener('pabx:sair', () => desenhar());
window.addEventListener('hashchange', () => desenhar());
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-usuario, .usuario')) document.querySelector('.menu-usuario')?.classList.add('oculto'); });

/** Rota atual: { empresaId, tela } a partir de #/tela ou #/empresa/ID/tela. */
function rota() {
  const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (partes[0] === 'empresa' && /^\d+$/.test(partes[1] ?? '')) return { empresaId: Number(partes[1]), tela: partes[2] || 'dashboard' };
  return { empresaId: null, tela: partes[0] || 'dashboard' };
}
const link = (empresaId, tela) => (empresaId ? `#/empresa/${empresaId}/${tela}` : `#/${tela}`);
const ir = (empresaId, tela) => { location.hash = link(empresaId, tela); };

async function desenhar() {
  pararTela?.();
  pararTela = null;
  const s = sessao.get();
  if (!s?.token) { pararSaude?.(); pararSaude = null; pararTelefone(); return telaEntrada(); }
  const u = s.usuario;
  // Telefone do painel: para os usuários das empresas (o ramal vem do usuário).
  if (!PLATAFORMA.includes(u.perfil)) iniciarTelefone({ empresaId: u.empresa_id });
  let { empresaId, tela } = rota();
  // Usuário de empresa sempre fica no painel da própria empresa.
  if (!PLATAFORMA.includes(u.perfil) && empresaId !== u.empresa_id) {
    history.replaceState(null, '', link(u.empresa_id, empresaId ? tela : 'dashboard'));
    ({ empresaId, tela } = rota());
  }
  const menu = empresaId ? MENU_EMPRESA : MENU_MASTER;
  const telas = empresaId ? TELAS_EMPRESA : TELAS_MASTER;
  const item = menu.find(([k, , , perfis, subs]) => (k === tela || subs?.some(([sk]) => sk === tela)) && (!perfis || perfis.includes(u.perfil)));
  if (!item || !telas[tela]) return ir(empresaId, 'dashboard');

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

  const titulo = item[4]?.find(([sk]) => sk === tela)?.[1] ?? item[1];
  const conteudo = el('main', { class: 'conteudo' });
  let recolhida = false;
  try { recolhida = localStorage.getItem('pabx.menu') === 'recolhido'; } catch { /* padrão */ }
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}` });

  const itens = menu.filter(([, , , perfis]) => !perfis || perfis.includes(u.perfil)).map(([k, rotulo, ic, , subs]) => {
    const ativo = k === tela || subs?.some(([sk]) => sk === tela);
    const a = el('a', { class: `item${ativo ? ' on' : ''}`, href: link(empresaId, subs ? subs[0][0] : k), title: rotulo }, icone(ic), el('span', { class: 'rotulo' }, rotulo));
    return subs && ativo ? [a, el('div', { class: 'grupo-sub' }, subs.map(([sk, sr]) => el('a', { class: `sub${sk === tela ? ' on' : ''}`, href: link(empresaId, sk) }, sr)))] : a;
  });
  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('pabx.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta'))),
    itens,
    empresaId && PLATAFORMA.includes(u.perfil) ? el('a', { class: 'item voltar', href: '#/empresas', title: 'Voltar ao master' }, icone('entrar'), el('span', { class: 'rotulo' }, 'Voltar ao master')) : null);

  const trilha = el('div', { class: 'trilha' });
  if (empresaId) trilha.append(el('a', { href: '#/empresas' }, 'Empresas'), el('span', { class: 'sep' }, '/'), el('a', { href: link(empresaId, 'dashboard') }, nomeEmpresa));

  const subtitulo = SUBTITULOS[tela] ? el('p', { class: 'subtitulo' }, SUBTITULOS[tela]) : null;
  const topo = el('header', { class: 'topo' }, el('div', {}, empresaId && PLATAFORMA.includes(u.perfil) ? trilha : null, el('h1', { style: 'margin:0' }, titulo), subtitulo),
    ferramentas(u));
  casca.append(lateral, el('div', { class: 'principal' }, topo, conteudo));
  limpar(raiz, casca);
  document.title = `${titulo} · ${nomeEmpresa ? `${nomeEmpresa} · ` : ''}${nomePlataforma}`;

  const ctx = {
    usuario: u, empresaId, nomeEmpresa, conteudo,
    master: PLATAFORMA.includes(u.perfil), soMaster: u.perfil === 'master', somenteLeitura: u.perfil === 'supervisor',
    parar: (fn) => { pararTela = fn; },
    ir: (tela2, eid = empresaId) => ir(eid, tela2),
    renomearEmpresa: (id, nome) => nomesEmpresa.set(id, nome),
  };
  try {
    await telas[tela](ctx);
  } catch (err) {
    toast(err.message, true);
  }
}

function ferramentas(u) {
  const tema = document.documentElement.dataset.tema || 'claro';
  const trocar = (t) => {
    document.documentElement.dataset.tema = t;
    try { localStorage.setItem('pabx.tema', t); } catch { /* ignora */ }
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
  return el('div', { class: 'ferramentas' }, status,
    el('button', { class: tema === 'claro' ? 'on' : '', title: 'Tema claro', dataset: { temaBtn: 'claro' }, onclick: () => trocar('claro') }, icone('sol')),
    el('button', { class: tema === 'escuro' ? 'on' : '', title: 'Tema escuro', dataset: { temaBtn: 'escuro' }, onclick: () => trocar('escuro') }, icone('lua')),
    el('button', { class: 'usuario', title: u.nome, onclick: () => menu.classList.toggle('oculto') }, el('span', { class: 'avatar' }, iniciais(u.nome)), el('span', { class: 'nome' }, u.nome), icone('abaixo')),
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
      desenhar();
    });
  });
  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'cartao' },
    marca(nomePlataforma), el('h1', { style: 'margin:28px 0 4px;font-size:20px' }, 'Entrar no painel'),
    el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'Use o e-mail e a senha que você recebeu.'), f)));
  f.querySelector('input').focus();
}

api.get('/publico').then((p) => { nomePlataforma = p.nome || 'ZOE PABX Inteligente'; }).catch(() => {}).finally(desenhar);
