import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, lerForm, campo, formModal, repetir, definirHoje, PERFIS } from './ui.js';
import { TELAS_MASTER } from './telas/master.js';
import { TELAS_EMPRESA } from './telas/empresa.js';

const raiz = $('#app');
let pararTela = null;
let nomePlataforma = 'Payax PDV';
const nomesEmpresa = new Map();

const PLATAFORMA = ['master', 'suporte'];
// [rota, rótulo, ícone, perfis que veem (vazio = todos)]
const MENU_MASTER = [
  ['painel', 'Visão geral', 'dashboard'], ['empresas', 'Empresas', 'empresas'], ['usuarios', 'Usuários', 'usuarios'],
  ['auditoria', 'Auditoria', 'seguranca'], ['configuracoes', 'Configurações', 'configuracoes', ['master']],
];
const MENU_EMPRESA = [
  ['pdv', 'Balcão', 'pdv', ['master', 'suporte', 'admin', 'operador']],
  ['caixa', 'Caixa', 'caixa'],
  ['recebimentos', 'Recebimentos', 'recebimentos'],
  ['conferencia', 'Conferência IXC', 'conferencia'],
  ['maquininhas', 'Maquininhas', 'maquininha', ['master', 'suporte', 'admin', 'supervisor']],
  ['cadastros', 'Lojas, PDVs e usuários', 'cadastros', ['master', 'suporte', 'admin']],
  ['configuracoes', 'Configurações', 'configuracoes', ['master', 'suporte', 'admin', 'supervisor']],
];

// Frase sob o título de cada tela.
const SUBTITULOS = {
  pdv: 'Receba as faturas do cliente no balcão',
  caixa: 'Abertura, sangria, suprimento e fechamento',
  recebimentos: 'Tudo o que passou pelo PDV, com a situação da baixa no IXC',
  conferencia: 'O que o PDV recebeu × o que o IXC registrou',
  maquininhas: 'Maquininhas de cartão e cobranças',
  cadastros: 'Lojas, estações de caixa e quem usa o PDV',
  configuracoes: 'IXC, multa e juros, comprovante',
  painel: 'Recebimentos e pendências de todas as empresas',
  empresas: 'Empresas atendidas pela plataforma',
  usuarios: 'Quem acessa o sistema e com qual perfil',
  auditoria: 'Tudo o que foi feito no sistema',
};
let pararSaude = null;

window.addEventListener('pdv:sair', () => desenhar());
window.addEventListener('hashchange', () => desenhar());
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-usuario, .usuario')) document.querySelector('.menu-usuario')?.classList.add('oculto'); });

/** Rota atual: { empresaId, tela } a partir de #/tela ou #/empresa/ID/tela. */
function rota() {
  const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (partes[0] === 'empresa' && /^\d+$/.test(partes[1] ?? '')) return { empresaId: Number(partes[1]), tela: partes[2] || 'pdv' };
  return { empresaId: null, tela: partes[0] || 'painel' };
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
    const inicial = u.perfil === 'operador' ? 'pdv' : 'conferencia';
    history.replaceState(null, '', link(u.empresa_id, empresaId ? tela : inicial));
    ({ empresaId, tela } = rota());
  }
  const menu = empresaId ? MENU_EMPRESA : MENU_MASTER;
  const telas = empresaId ? TELAS_EMPRESA : TELAS_MASTER;
  const item = menu.find(([k, , , perfis]) => k === tela && (!perfis || perfis.includes(u.perfil)));
  if (!item || !telas[tela]) return ir(empresaId, empresaId ? (u.perfil === 'operador' ? 'pdv' : 'conferencia') : 'painel');

  let nomeEmpresa = null;
  if (empresaId) {
    nomeEmpresa = nomesEmpresa.get(empresaId);
    if (!nomeEmpresa) {
      try {
        nomeEmpresa = (await api.get(`/empresas/${empresaId}`)).empresa.nome;
        nomesEmpresa.set(empresaId, nomeEmpresa);
      } catch (err) {
        toast(err.message, true);
        return PLATAFORMA.includes(u.perfil) ? ir(null, 'empresas') : undefined;
      }
    }
  }

  const conteudo = el('main', { class: 'conteudo' });
  let recolhida = false;
  try { recolhida = localStorage.getItem('pdv.menu') === 'recolhido'; } catch { /* padrão */ }
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}` });

  const itens = menu.filter(([, , , perfis]) => !perfis || perfis.includes(u.perfil)).map(([k, rotulo, ic]) =>
    el('a', { class: `item${k === tela ? ' on' : ''}`, href: link(empresaId, k), title: rotulo }, icone(ic), el('span', { class: 'rotulo' }, rotulo)));
  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('pdv.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta'))),
    itens,
    empresaId && PLATAFORMA.includes(u.perfil) ? el('a', { class: 'item voltar', href: '#/empresas', title: 'Voltar à plataforma' }, icone('entrar'), el('span', { class: 'rotulo' }, 'Voltar à plataforma')) : null);

  const trilha = el('div', { class: 'trilha' });
  if (empresaId) trilha.append(el('a', { href: '#/empresas' }, 'Empresas'), el('span', { class: 'sep' }, '/'), el('a', { href: link(empresaId, 'conferencia') }, nomeEmpresa));

  const topo = el('header', { class: 'topo' },
    el('div', {}, empresaId && PLATAFORMA.includes(u.perfil) ? trilha : null, el('h1', { style: 'margin:0' }, item[1]),
      SUBTITULOS[tela] ? el('p', { class: 'subtitulo' }, SUBTITULOS[tela]) : null),
    ferramentas(u));
  casca.append(lateral, el('div', { class: 'principal' }, topo, conteudo));
  limpar(raiz, casca);
  document.title = `${item[1]} · ${nomeEmpresa ? `${nomeEmpresa} · ` : ''}${nomePlataforma}`;

  const ctx = {
    usuario: u, empresaId, nomeEmpresa, conteudo,
    master: PLATAFORMA.includes(u.perfil),
    soMaster: u.perfil === 'master',
    administra: ['master', 'suporte', 'admin'].includes(u.perfil),
    supervisiona: ['master', 'suporte', 'admin', 'supervisor'].includes(u.perfil),
    opera: ['master', 'suporte', 'admin', 'operador'].includes(u.perfil),
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
    try { localStorage.setItem('pdv.tema', t); } catch { /* ignora */ }
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
      location.hash = '';
      desenhar();
    });
  });
  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'cartao' },
    marca(nomePlataforma), el('h1', { style: 'margin:28px 0 4px;font-size:20px' }, 'Entrar no PDV'),
    el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'Use o e-mail e a senha que você recebeu.'), f)));
  f.querySelector('input').focus();
}

api.get('/publico').then((p) => { nomePlataforma = p.nome || 'Payax PDV'; definirHoje(p.hoje); }).catch(() => {}).finally(desenhar);
