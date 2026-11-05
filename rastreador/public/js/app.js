import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, lerForm, campo, formModal, PERFIS } from './ui.js';
import { TELAS_MASTER } from './master.js';
import { TELAS_EMPRESA } from './empresa.js';
import { iniciarCena } from './cena-entrada.js';
import { efeitosPausados, alternarEfeitos } from './efeitos.js';

const raiz = $('#app');
let pararTela = null;
let nomePlataforma = 'Rastreador';
let versao = '';
const nomesEmpresa = new Map();

const PLATAFORMA = ['master', 'suporte'];
// [rota, rótulo, ícone, perfis que veem (vazio = todos), seções]
// Seções: [rota, rótulo, ícone, descrição, perfis que veem]. O item do menu abre a primeira seção permitida, e a página mostra as
// seções em cartões no topo (as rotas de cada seção continuam as mesmas: #/comandos, #/integracoes...).
const MENU_MASTER = [
  ['dashboard', 'Dashboard', 'dashboard'], ['mapa', 'Mapa geral', 'mapa'], ['empresas', 'Empresas', 'empresas'], ['financeiro', 'Financeiro', 'carteira', ['master']],
  ['rastreadores', 'Rastreadores', 'rastreadores'],
  ['usuarios', 'Permissões e usuários', 'usuarios', ['master']], ['diagnostico', 'Diagnóstico', 'diagnostico'],
  ['configuracoes', 'Configurações', 'configuracoes', null, [
    ['configuracoes', 'Parâmetros', 'configuracoes', 'Nome da plataforma e regras do rastreamento', ['master']],
    ['comandos-gt06', 'Comandos GT06', 'comandos', 'Textos enviados aos rastreadores sem comandos próprios', ['master']],
    ['integracoes', 'Integrações', 'integracoes', 'Chaves de API e envio de posições por outros sistemas'],
  ]],
  ['atividades', 'Atividades', 'seguranca', ['master']],
];
const MENU_EMPRESA = [
  ['dashboard', 'Dashboard', 'dashboard'], ['mapa', 'Mapa ao vivo', 'mapa'], ['historico', 'Histórico', 'historico'], ['alertas', 'Alertas', 'alertas'],
  ['veiculos', 'Veículos', 'veiculos'], ['motoristas', 'Motoristas', 'motoristas'], ['cercas', 'Cercas', 'cercas'], ['manutencao', 'Manutenção', 'manutencao'],
  ['relatorios', 'Relatórios', 'relatorios'],
  ['configuracoes', 'Configurações', 'configuracoes', null, [
    ['configuracoes', 'Geral', 'configuracoes', 'Alertas, horário de uso, contato, plano e usuários'],
    ['comandos', 'Comandos', 'comandos', 'Envio de comandos aos rastreadores e as respostas'],
    ['integracoes', 'Integrações', 'integracoes', 'Chaves de API e envio de posições por outros sistemas', ['master', 'suporte', 'cliente']],
  ]],
];

// Linha de apoio embaixo do título (as telas que já têm a própria explicação ficam sem).
const SUBTITULOS_MASTER = {
  dashboard: 'Resumo da plataforma, das empresas e dos equipamentos.', mapa: 'Última posição dos veículos de todas as empresas.',
  empresas: 'Clientes da plataforma, planos e limites.', financeiro: 'Valor mensal de cada cliente: mensalidade por veículo × veículos ativos.', rastreadores: 'Equipamentos cadastrados, estoque e instalação.',
  usuarios: 'Quem acessa a plataforma e o que cada perfil pode fazer.', diagnostico: 'Conexões dos equipamentos e mensagens recebidas.',
  configuracoes: 'Parâmetros da plataforma, comandos GT06 e integrações.', atividades: 'Registro das ações feitas no painel.',
};
const SUBTITULOS_EMPRESA = {
  dashboard: 'Resumo da frota, dos deslocamentos e dos alertas.', mapa: 'Última posição de cada veículo.', historico: 'Trajetos, paradas e viagens por período.',
  alertas: 'Ocorrências dos veículos e o que já foi tratado.', cercas: 'Áreas monitoradas com aviso de entrada e saída.', relatorios: 'Relatórios por veículo e período.',
  configuracoes: 'Preferências da empresa, comandos e integrações.',
};

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
  const permitido = (perfis) => !perfis || perfis.includes(u.perfil);
  const secoesDe = (subs) => (subs ?? []).filter(([, , , , sp]) => permitido(sp));
  const item = menu.find(([k, , , perfis, subs]) => permitido(perfis) && (subs ? secoesDe(subs).some(([sk]) => sk === tela) : k === tela));
  if (!item || !telas[tela]) return ir(empresaId, 'dashboard');
  const secoes = secoesDe(item[4]);
  const secao = secoes.find(([sk]) => sk === tela);

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

  const titulo = item[1];
  const conteudo = el('main', { class: 'conteudo' });
  let recolhida = false;
  try { recolhida = localStorage.getItem('rastreador.menu') === 'recolhido'; } catch { /* padrão */ }
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}` });

  const itens = menu.filter(([, , , perfis, subs]) => permitido(perfis) && (!subs || secoesDe(subs).length)).map(([k, rotulo, ic, , subs]) => {
    const ativo = subs ? secoesDe(subs).some(([sk]) => sk === tela) : k === tela;
    return el('a', { class: `item${ativo ? ' on' : ''}`, href: link(empresaId, subs ? secoesDe(subs)[0][0] : k), title: rotulo, 'aria-current': ativo ? 'page' : null },
      icone(ic), el('span', { class: 'rotulo' }, rotulo));
  });
  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('rastreador.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta'))),
    itens,
    empresaId && PLATAFORMA.includes(u.perfil) ? el('a', { class: 'item voltar', href: '#/empresas', title: 'Voltar ao master' }, icone('entrar'), el('span', { class: 'rotulo' }, 'Voltar ao master')) : null,
    el('div', { class: 'rodape-lateral' }, el('strong', {}, nomeEmpresa ?? nomePlataforma), PERFIS[u.perfil] ?? '',
      versao ? el('span', { class: 'versao', title: 'Versão instalada' }, `Versão ${versao}`) : null));
  lateral.children[0].after(el('div', { class: 'rotulo-secao' }, empresaId ? 'Painel da empresa' : 'Plataforma'));

  const trilha = el('nav', { class: 'trilha', 'aria-label': 'Você está em' });
  if (empresaId) {
    if (PLATAFORMA.includes(u.perfil)) trilha.append(el('a', { href: '#/empresas' }, 'Empresas'), el('span', { class: 'sep' }, '/'));
    trilha.append(el('a', { href: link(empresaId, 'dashboard') }, nomeEmpresa), el('span', { class: 'sep' }, '/'));
  } else {
    trilha.append(nomePlataforma, el('span', { class: 'sep', 'aria-hidden': 'true' }, '/'));
  }
  // Nas páginas com seções (Configurações), a trilha termina na seção: ".../ Configurações / Comandos".
  if (secao) trilha.append(el('a', { href: link(empresaId, secoes[0][0]) }, titulo), el('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), el('strong', {}, secao[1]));
  else trilha.append(el('strong', {}, titulo));

  const subtitulo = (empresaId ? SUBTITULOS_EMPRESA : SUBTITULOS_MASTER)[secao ? item[0] : tela];
  const topo = el('header', { class: 'topo' }, el('div', {}, trilha,
    el('h1', { style: 'margin:0' }, titulo), subtitulo ? el('p', { class: 'subtitulo' }, subtitulo) : null), ferramentas(u));
  // Seções em cartões no topo da página (ficam fora do conteúdo, que cada tela redesenha).
  const abas = secoes.length > 1 ? el('nav', { class: 'abas-config', 'aria-label': `Seções de ${titulo}` }, secoes.map(([sk, sr, sic, sd]) => {
    const on = sk === tela;
    return el('a', { class: `aba-config${on ? ' on' : ''}`, href: link(empresaId, sk), 'aria-current': on ? 'page' : null },
      el('span', { class: 'aba-icone' }, icone(sic)), el('span', { class: 'aba-texto' }, el('strong', {}, sr), el('small', {}, sd)));
  })) : null;
  casca.append(lateral, el('div', { class: 'principal' }, topo, abas, conteudo));
  limpar(raiz, casca);
  document.title = `${secao ? `${secao[1]} · ` : ''}${titulo} · ${nomeEmpresa ? `${nomeEmpresa} · ` : ''}${nomePlataforma}`;

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
  const tema = document.documentElement.dataset.tema || 'claro';
  const trocar = (t) => {
    document.documentElement.dataset.tema = t;
    try { localStorage.setItem('rastreador.tema', t); } catch { /* ignora */ }
    for (const b of document.querySelectorAll('[data-tema-btn]')) b.classList.toggle('on', b.dataset.temaBtn === t);
  };
  const menu = el('div', { class: 'menu-usuario oculto' },
    el('div', { class: 'quem' }, el('strong', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email), el('div', { class: 'pequeno mudo' }, PERFIS[u.perfil])),
    el('button', { onclick: () => { menu.classList.add('oculto'); alterarSenha(); } }, 'Alterar senha'),
    el('button', { onclick: () => { sessao.limpar(); nomesEmpresa.clear(); location.hash = ''; desenhar(); } }, 'Sair'));
  // Pausar / ativar os efeitos contínuos (gradiente, órbita, pulsos).
  const efeitos = el('button', { class: 'controle-efeitos', type: 'button' });
  const desenharEfeitos = () => {
    const p = efeitosPausados();
    efeitos.replaceChildren(icone(p ? 'play' : 'pausa'), el('span', {}, p ? 'Ativar efeitos' : 'Pausar efeitos'));
    efeitos.setAttribute('aria-pressed', String(p));
    efeitos.title = p ? 'Ativar os efeitos de movimento' : 'Pausar os efeitos de movimento';
  };
  efeitos.addEventListener('click', () => { alternarEfeitos(); desenharEfeitos(); });
  desenharEfeitos();
  return el('div', { class: 'ferramentas' },
    efeitos,
    el('button', { class: tema === 'claro' ? 'on' : '', title: 'Tema claro', 'aria-label': 'Tema claro', dataset: { temaBtn: 'claro' }, onclick: () => trocar('claro') }, icone('sol')),
    el('button', { class: tema === 'escuro' ? 'on' : '', title: 'Tema escuro', 'aria-label': 'Tema escuro', dataset: { temaBtn: 'escuro' }, onclick: () => trocar('escuro') }, icone('lua')),
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
    el('button', { class: 'btn primario entrar' }, 'Entrar', icone('entrar')));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button'), async () => {
      const r = await api.post('/auth/login', lerForm(f));
      sessao.set(r);
      desenhar();
    });
  });
  const rodape = el('div', { class: 'rodape-entrada', 'aria-live': 'polite' }, el('span', { class: 'ponto-vivo parado' }), 'Verificando o servidor…');
  // Cidade em 3D ao fundo, com os veículos sendo localizados; o login num cartão de vidro por cima.
  const cena = el('canvas', { class: 'cena', 'aria-hidden': 'true' });
  const recursos = ['Localização em tempo real', 'Bloqueio remoto', 'Cercas virtuais', 'Alertas no celular'];
  limpar(raiz, el('div', { class: 'entrada-3d' }, cena, el('div', { class: 'brilho' }),
    el('div', { class: 'entrada-conteudo' },
      el('section', { class: 'chamada' },
        marca(nomePlataforma),
        el('h1', {}, 'Sua frota,', el('br'), el('span', {}, 'ao vivo.')),
        el('p', {}, 'Acompanhe cada veículo no mapa, receba alertas na hora e bloqueie à distância, tudo em um só painel.'),
        el('ul', {}, recursos.map((r) => el('li', {}, el('i'), r)))),
      el('section', { class: 'cartao-vidro' },
        el('h2', {}, 'Entrar no painel'),
        el('p', { class: 'sub' }, 'Use o e-mail e a senha que você recebeu.'), f,
        rodape))));
  // O estado do servidor vem de uma consulta real (não fica "online" por padrão).
  api.get('/saude').then(() => {
    rodape.replaceChildren(el('span', { class: 'ponto-vivo' }), 'Servidor de rastreamento online');
  }).catch(() => {
    rodape.replaceChildren(el('span', { class: 'ponto-vivo erro' }), 'Sem resposta do servidor agora');
  });
  pararTela = iniciarCena(cena);
  f.querySelector('input').focus();
}

api.get('/publico').then((p) => { nomePlataforma = p.nome || 'Rastreador'; versao = p.versao || ''; }).catch(() => {}).finally(desenhar);
