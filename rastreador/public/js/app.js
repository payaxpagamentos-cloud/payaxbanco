import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, lerForm, campo, formModal, PERFIS } from './ui.js';
import { TELAS_MASTER } from './master.js';
import { TELAS_EMPRESA } from './empresa.js';

const raiz = $('#app');
let pararTela = null;
let nomePlataforma = 'Rastreador';
const nomesEmpresa = new Map();

const PLATAFORMA = ['master', 'suporte'];
// [rota, rótulo, ícone, perfis que veem (vazio = todos)]
const MENU_MASTER = [
  ['dashboard', 'Dashboard', 'dashboard'], ['mapa', 'Mapa geral', 'mapa'], ['empresas', 'Empresas', 'empresas'], ['rastreadores', 'Rastreadores', 'rastreadores'],
  ['usuarios', 'Permissões e usuários', 'usuarios', ['master']], ['diagnostico', 'Diagnóstico', 'diagnostico'],
  ['configuracoes', 'Configurações', 'configuracoes', ['master']], ['integracoes', 'Integrações', 'integracoes'], ['atividades', 'Atividades', 'seguranca', ['master']],
];
const MENU_EMPRESA = [
  ['dashboard', 'Dashboard', 'dashboard'], ['mapa', 'Mapa ao vivo', 'mapa'], ['historico', 'Histórico', 'historico'], ['alertas', 'Alertas', 'alertas'],
  ['veiculos', 'Veículos', 'veiculos'], ['motoristas', 'Motoristas', 'motoristas'], ['cercas', 'Cercas', 'cercas'], ['manutencao', 'Manutenção', 'manutencao'],
  ['relatorios', 'Relatórios', 'relatorios'], ['comandos', 'Comandos', 'comandos'], ['configuracoes', 'Configurações', 'configuracoes'],
  ['integracoes', 'Integrações', 'integracoes', ['master', 'suporte', 'cliente']],
];

window.addEventListener('rastreador:sair', () => desenhar());
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
  // Janela aberta numa tela não fica por cima da próxima.
  for (const m of document.querySelectorAll('.modal-fundo')) m.remove();
  const s = sessao.get();
  if (!s?.token) return telaEntrada();
  const u = s.usuario;
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
  try { recolhida = localStorage.getItem('rastreador.menu') === 'recolhido'; } catch { /* padrão */ }
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}` });

  const itens = menu.filter(([, , , perfis]) => !perfis || perfis.includes(u.perfil)).map(([k, rotulo, ic, , subs]) => {
    const ativo = k === tela || subs?.some(([sk]) => sk === tela);
    const a = el('a', { class: `item${ativo ? ' on' : ''}`, href: link(empresaId, subs ? subs[0][0] : k), title: rotulo }, icone(ic), el('span', { class: 'rotulo' }, rotulo));
    return subs && ativo ? [a, el('div', { class: 'grupo-sub' }, subs.map(([sk, sr]) => el('a', { class: `sub${sk === tela ? ' on' : ''}`, href: link(empresaId, sk) }, sr)))] : a;
  });
  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('rastreador.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta'))),
    itens,
    empresaId && PLATAFORMA.includes(u.perfil) ? el('a', { class: 'item voltar', href: '#/empresas', title: 'Voltar ao master' }, icone('entrar'), el('span', { class: 'rotulo' }, 'Voltar ao master')) : null);

  const trilha = el('div', { class: 'trilha' });
  if (empresaId) {
    if (PLATAFORMA.includes(u.perfil)) trilha.append(el('a', { href: '#/empresas' }, 'Empresas'), el('span', { class: 'sep' }, '/'));
    trilha.append(el('a', { href: link(empresaId, 'dashboard') }, nomeEmpresa.toUpperCase()), el('span', { class: 'sep' }, '/'), titulo);
  } else {
    trilha.append(titulo);
  }

  const topo = el('header', { class: 'topo' }, el('div', {}, el('h1', { style: 'margin:0' }, titulo), trilha), ferramentas(u));
  casca.append(lateral, el('div', { class: 'principal' }, topo, conteudo));
  limpar(raiz, casca);
  document.title = `${titulo} · ${nomeEmpresa ? `${nomeEmpresa} · ` : ''}${nomePlataforma}`;

  const ctx = {
    usuario: u, empresaId, nomeEmpresa, conteudo,
    master: PLATAFORMA.includes(u.perfil), soMaster: u.perfil === 'master', somenteLeitura: u.perfil === 'operador',
    telaCheia: () => { conteudo.classList.add('cheio'); casca.classList.add('com-mapa'); },
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
  const tema = document.documentElement.dataset.tema || 'escuro';
  const trocar = (t) => {
    document.documentElement.dataset.tema = t;
    try { localStorage.setItem('rastreador.tema', t); } catch { /* ignora */ }
    for (const b of document.querySelectorAll('[data-tema-btn]')) b.classList.toggle('on', b.dataset.temaBtn === t);
  };
  const menu = el('div', { class: 'menu-usuario oculto' },
    el('div', { class: 'quem' }, el('strong', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email), el('div', { class: 'pequeno mudo' }, PERFIS[u.perfil])),
    el('button', { onclick: () => { menu.classList.add('oculto'); alterarSenha(); } }, 'Alterar senha'),
    el('button', { onclick: () => { sessao.limpar(); nomesEmpresa.clear(); location.hash = ''; desenhar(); } }, 'Sair'));
  return el('div', { class: 'ferramentas' },
    el('button', { class: tema === 'claro' ? 'on' : '', title: 'Tema claro', dataset: { temaBtn: 'claro' }, onclick: () => trocar('claro') }, icone('sol')),
    el('button', { class: tema === 'escuro' ? 'on' : '', title: 'Tema escuro', dataset: { temaBtn: 'escuro' }, onclick: () => trocar('escuro') }, icone('lua')),
    el('button', { class: 'usuario', title: u.nome, onclick: () => menu.classList.toggle('oculto') }, el('span', { class: 'avatar' }, iniciais(u.nome)), el('span', { class: 'nome' }, u.nome)),
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
    el('button', { class: 'btn primario', style: 'min-height:44px' }, 'Entrar'));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button'), async () => {
      const r = await api.post('/auth/login', lerForm(f));
      sessao.set(r);
      desenhar();
    });
  });
  limpar(raiz, el('div', { class: 'entrada' }, el('div', { class: 'cartao' },
    marca(nomePlataforma), el('h1', { style: 'margin:18px 0 4px;font-size:22px' }, 'Entrar no painel'),
    el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'Use o e-mail e a senha que você recebeu.'), f)));
  f.querySelector('input').focus();
}

api.get('/publico').then((p) => { nomePlataforma = p.nome || 'Rastreador'; }).catch(() => {}).finally(desenhar);
