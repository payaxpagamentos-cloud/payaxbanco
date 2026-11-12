import { api, sessao } from './api.js';
import { el, $, limpar, icone, iniciais, toast, modal, acao, lerForm, marca, RAIZ, PERFIS } from './ui.js';
import painel from './pages/painel.js';
import vendas from './pages/vendas.js';
import produtos from './pages/produtos.js';
import estoque from './pages/estoque.js';
import compras from './pages/compras.js';
import financeiro from './pages/financeiro.js';
import moradores from './pages/moradores.js';
import relatorios from './pages/relatorios.js';
import configuracoes from './pages/config.js';
import minhaConta from './pages/minhaconta.js';

const EQUIPE = ['admin', 'gerente', 'caixa', 'estoque'];
const MENU = [
  { secao: 'Dia a dia' },
  { rota: 'painel', rotulo: 'Painel', icone: 'painel', pagina: painel, perfis: EQUIPE },
  { rota: 'vendas', rotulo: 'Vendas do terminal', icone: 'pdv', pagina: vendas, perfis: ['admin', 'gerente', 'caixa'] },
  { secao: 'Mercadoria' },
  { rota: 'produtos', rotulo: 'Produtos', icone: 'produtos', pagina: produtos, perfis: EQUIPE },
  { rota: 'estoque', rotulo: 'Estoque', icone: 'estoque', pagina: estoque, perfis: EQUIPE },
  { rota: 'compras', rotulo: 'Compras', icone: 'compras', pagina: compras, perfis: ['admin', 'gerente', 'estoque'] },
  { secao: 'Gestão' },
  { rota: 'moradores', rotulo: 'Moradores', icone: 'moradores', pagina: moradores, perfis: EQUIPE },
  { rota: 'financeiro', rotulo: 'Financeiro', icone: 'financeiro', pagina: financeiro, perfis: ['admin', 'gerente'] },
  { rota: 'relatorios', rotulo: 'Relatórios', icone: 'relatorios', pagina: relatorios, perfis: ['admin', 'gerente'] },
  { rota: 'config', rotulo: 'Configurações', icone: 'config', pagina: configuracoes, perfis: ['admin', 'gerente'] },
];
const MENU_MORADOR = [
  { secao: 'Minha conta' },
  { rota: 'minha-conta', rotulo: 'Meu consumo', icone: 'moradores', pagina: minhaConta, perfis: ['morador'] },
];

const estado = { usuario: null, publico: { nome_mercado: 'Mercadinho' }, limparPagina: null };
const itens = () => (estado.usuario?.perfil === 'morador' ? MENU_MORADOR : MENU).filter((m) => m.secao || m.perfis.includes(estado.usuario.perfil));
const rotaPadrao = () => (estado.usuario?.perfil === 'morador' ? 'minha-conta' : 'painel');

/* ---------- tema ---------- */
const temaSalvo = () => { try { return localStorage.getItem('mercadinho.tema'); } catch { return null; } };
function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  try { localStorage.setItem('mercadinho.tema', tema); } catch { /* ignora */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tema === 'claro' ? '#EDF1F9' : '#05070F');
}
aplicarTema(temaSalvo() ?? 'escuro');

/* ---------- entrada ---------- */

/** Não há envio de e-mail no sistema: quem redefine a senha é um administrador, em Usuários. */
const esqueciSenha = () => modal('Esqueci minha senha', (fechar) => [
  el('p', { class: 'mudo' }, 'O sistema não envia e-mail de recuperação. Procure a administração do mercado: '
    + 'quem tem perfil de administrador abre Configurações → Usuários, escolhe o seu nome e define uma senha nova.'),
  el('p', { class: 'mudo' }, 'Depois de entrar com ela, troque por uma senha sua em Minha conta.'),
  el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', onclick: () => fechar() }, 'Entendi')),
]);

const falarComSuporte = () => modal('Precisa de ajuda?', (fechar) => [
  el('p', { class: 'mudo' }, `O ${estado.publico.nome_mercado} é operado pela própria administração do condomínio — `
    + 'é com ela que se resolve acesso, cadastro de produto, preço e conta de morador.'),
  el('p', { class: 'mudo' }, 'Se o sistema estiver fora do ar ou apresentando erro, avise quem cuida da instalação.'),
  el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', onclick: () => fechar() }, 'Entendi')),
]);

function telaLogin(erro) {
  const campoSenha = el('input', { name: 'senha', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Digite sua senha' });
  const olho = el('button', { type: 'button', class: 'ver-senha', 'aria-label': 'Mostrar senha', onclick: alternarSenha }, icone('olho'));
  const lembrar = el('input', { type: 'checkbox' });

  function alternarSenha() {
    const mostrar = campoSenha.type === 'password';
    campoSenha.type = mostrar ? 'text' : 'password';
    olho.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
    limpar(olho, icone(mostrar ? 'olho-fechado' : 'olho'));
    campoSenha.focus();
  }

  const form = el('form', { class: 'form', onsubmit: entrar },
    el('label', { class: 'campo' }, 'E-mail',
      el('div', { class: 'campo-icone' }, icone('email'),
        el('input', { name: 'email', type: 'email', autocomplete: 'username', required: true, placeholder: 'Digite seu e-mail' }))),
    el('label', { class: 'campo' }, 'Senha',
      el('div', { class: 'campo-icone' }, icone('cadeado'), campoSenha, olho)),
    erro ? el('p', { class: 'etiqueta erro' }, erro) : null,
    el('div', { class: 'opcoes' },
      el('label', { class: 'lembrar' }, lembrar, 'Manter conectado'),
      el('button', { type: 'button', class: 'elo', onclick: esqueciSenha }, 'Esqueci minha senha')),
    el('button', { class: 'btn primario grande' }, 'Entrar no sistema', icone('seta-direita')));

  async function entrar(e) {
    e.preventDefault();
    const dados = lerForm(e.target);
    const botao = e.target.querySelector('button[class*="primario"]');
    await acao(botao, async () => {
      const r = await api.post('/auth/login', { ...dados, lembrar: lembrar.checked });
      sessao.set(r);
      estado.usuario = r.usuario;
      location.hash = `#/${rotaPadrao()}`;
      desenharLayout();
      navegar();
    });
  }

  limpar($('#app'), el('div', { class: 'entrada' },
    el('div', { class: 'painel-entrada' },
      el('div', { class: 'cartao caixa' },
        el('span', { class: 'selo-entrada' }, icone('entrar')),
        el('h2', {}, 'Bem-vindo'),
        form,
        el('p', { class: 'ajuda' }, 'Precisa de ajuda? ',
          el('button', { type: 'button', class: 'elo', onclick: falarComSuporte }, 'Fale com o suporte'))))));
}

/* ---------- layout ---------- */
function desenharLayout() {
  const u = estado.usuario;
  const menu = el('aside', { class: 'menu', id: 'menu' },
    marca(estado.publico.nome_mercado, estado.publico.condominio || 'do Condomínio'),
    el('nav', { id: 'navegacao' }),
    el('div', { class: 'rodape' }, `${estado.publico.nome_mercado} · v${estado.publico.versao ?? '1.0'}`));

  const topo = el('header', { class: 'topo' },
    el('button', { class: 'btn icone menu-botao', 'aria-label': 'Menu', onclick: () => $('#menu').classList.toggle('aberto') }, icone('menu')),
    el('div', { class: 'crescer' }, el('h1', { id: 'titulo' }, ''), el('div', { class: 'subtitulo', id: 'subtitulo' }, '')),
    el('div', { class: 'usuario' },
      el('button', {
        class: 'btn icone fantasma', 'aria-label': 'Alternar tema', title: 'Alternar entre claro e escuro',
        onclick: () => aplicarTema(document.documentElement.dataset.tema === 'claro' ? 'escuro' : 'claro'),
      }, icone(document.documentElement.dataset.tema === 'claro' ? 'lua' : 'sol')),
      el('div', { class: 'direita pequeno oculto-celular' }, el('div', { class: 'destaque' }, u.nome), el('div', { class: 'mudo' }, PERFIS[u.perfil])),
      el('button', { class: 'avatar', title: 'Minha senha', onclick: trocarSenha }, iniciais(u.nome)),
      el('button', { class: 'btn icone fantasma', 'aria-label': 'Sair', title: 'Sair', onclick: sair }, icone('sair'))));

  limpar($('#app'), el('div', { class: 'layout' }, menu, el('div', { class: 'principal' }, topo, el('main', { class: 'conteudo', id: 'conteudo' }))));
}

function desenharMenu(rotaAtual) {
  const nav = $('#navegacao');
  if (!nav) return;
  limpar(nav, itens().map((m) => (m.secao
    ? el('div', { class: 'secao' }, m.secao)
    : el('a', { href: `#/${m.rota}`, class: m.rota === rotaAtual ? 'ativo' : null, onclick: () => $('#menu').classList.remove('aberto') },
      icone(m.icone), el('span', {}, m.rotulo)))));
}

const definirTitulo = (titulo, subtitulo = '') => {
  if ($('#titulo')) $('#titulo').textContent = titulo;
  if ($('#subtitulo')) $('#subtitulo').textContent = subtitulo;
  document.title = `${titulo} · ${estado.publico.nome_mercado}`;
};

async function navegar() {
  if (!estado.usuario) return telaLogin();
  const rota = (location.hash.replace(/^#\/?/, '').split('/')[0]) || rotaPadrao();
  const item = itens().find((m) => m.rota === rota);
  if (!item) { location.hash = `#/${rotaPadrao()}`; return; }
  if (!$('#conteudo')) desenharLayout();
  desenharMenu(rota);
  definirTitulo(item.rotulo);
  // Cada página pode devolver uma função de limpeza (parar timers, por exemplo).
  if (estado.limparPagina) { estado.limparPagina(); estado.limparPagina = null; }
  const alvo = $('#conteudo');
  limpar(alvo, el('div', { class: 'carregando' }, el('div', { class: 'girando' })));
  try {
    estado.limparPagina = await item.pagina({ alvo, usuario: estado.usuario, definirTitulo, navegar, publico: estado.publico }) ?? null;
  } catch (err) {
    limpar(alvo, el('div', { class: 'cartao' }, el('h2', {}, 'Não foi possível abrir esta tela'), el('p', { class: 'mudo' }, err.message),
      el('button', { class: 'btn', onclick: navegar }, 'Tentar de novo')));
  }
}

const trocarSenha = () => modal('Trocar minha senha', (fechar) => {
  const form = el('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const d = lerForm(e.target);
    if (d.nova !== d.repetir) return toast('A nova senha e a repetição estão diferentes.', 'erro');
    await acao(e.target.querySelector('button[type=submit]'), async () => {
      await api.post('/auth/senha', { atual: d.atual, nova: d.nova });
      toast('Senha trocada.');
      fechar();
    });
  } },
  el('label', { class: 'campo' }, 'Senha atual', el('input', { name: 'atual', type: 'password', required: true })),
  el('label', { class: 'campo' }, 'Nova senha', el('input', { name: 'nova', type: 'password', minlength: 8, required: true })),
  el('label', { class: 'campo' }, 'Repita a nova senha', el('input', { name: 'repetir', type: 'password', minlength: 8, required: true })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Trocar senha')));
  return form;
});

function sair() {
  sessao.limpar();
  estado.usuario = null;
  if (estado.limparPagina) { estado.limparPagina(); estado.limparPagina = null; }
  telaLogin();
}

window.addEventListener('mercadinho:sair', () => { estado.usuario = null; telaLogin('Sua sessão expirou. Entre de novo.'); });
window.addEventListener('hashchange', navegar);

(async function iniciar() {
  try { estado.publico = await api.get('/publico'); } catch { /* servidor fora do ar: segue com o padrão */ }
  const s = sessao.get();
  if (!s?.token) return telaLogin();
  try {
    estado.usuario = (await api.get('/auth/me')).usuario;
  } catch {
    sessao.limpar();
    return telaLogin();
  }
  desenharLayout();
  navegar();
}());
