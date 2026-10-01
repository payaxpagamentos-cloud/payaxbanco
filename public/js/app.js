import { api, sessao } from './api.js';
import { html, $, $$, icone, iniciais, toast, modal, dadosForm } from './ui.js';
import { usuarioAtual, definirTitulo } from './contexto.js';
import login from './pages/login.js';
import dashboard from './pages/dashboard.js';
import { listaClientes, detalheCliente } from './pages/clientes.js';
import { listaContas, detalheConta } from './pages/contas.js';
import operacoes from './pages/operacoes.js';
import pix from './pages/pix.js';
import { listaEmprestimos, detalheEmprestimo } from './pages/emprestimos.js';
import transacoes from './pages/transacoes.js';
import relatorios from './pages/relatorios.js';
import usuarios from './pages/usuarios.js';
import auditoria from './pages/auditoria.js';

const TODOS = ['admin', 'gerente', 'operador'];
const MENU = [
  { secao: 'Visão geral' },
  { rota: 'painel', rotulo: 'Painel', icone: 'painel', perfis: TODOS },
  { secao: 'Cadastro' },
  { rota: 'clientes', rotulo: 'Clientes', icone: 'clientes', perfis: TODOS },
  { rota: 'contas', rotulo: 'Contas', icone: 'contas', perfis: TODOS },
  { rota: 'pix', rotulo: 'Chaves PIX', icone: 'pix', perfis: TODOS },
  { secao: 'Movimentação' },
  { rota: 'operacoes', rotulo: 'Operações', icone: 'operacoes', perfis: TODOS },
  { rota: 'transacoes', rotulo: 'Transações', icone: 'transacoes', perfis: TODOS },
  { rota: 'emprestimos', rotulo: 'Empréstimos', icone: 'emprestimos', perfis: TODOS },
  { secao: 'Gestão' },
  { rota: 'relatorios', rotulo: 'Relatórios', icone: 'relatorios', perfis: ['admin', 'gerente'] },
  { rota: 'auditoria', rotulo: 'Auditoria', icone: 'auditoria', perfis: ['admin', 'gerente'] },
  { rota: 'usuarios', rotulo: 'Usuários', icone: 'usuarios', perfis: ['admin'] },
];

const ROTAS = {
  painel: dashboard,
  clientes: (ctx) => (ctx.id ? detalheCliente(ctx) : listaClientes(ctx)),
  contas: (ctx) => (ctx.id ? detalheConta(ctx) : listaContas(ctx)),
  operacoes,
  pix,
  emprestimos: (ctx) => (ctx.id ? detalheEmprestimo(ctx) : listaEmprestimos(ctx)),
  transacoes,
  relatorios,
  usuarios,
  auditoria,
};

const PERFIL = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };


function renderLayout() {
  const u = usuarioAtual();
  $('#app').innerHTML = String(html`
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <img src="/img/logo-payax-branco.svg" alt="PAY AX">
        </div>
        <div class="brand" style="border:0;padding-bottom:0"><span class="produto">Banqueiro</span></div>
        <nav class="nav">
          ${MENU.filter((m) => m.secao || m.perfis.includes(u.perfil)).map((m) => (m.secao
            ? html`<div class="secao">${m.secao}</div>`
            : html`<a href="#/${m.rota}" data-rota="${m.rota}">${icone(m.icone)}<span>${m.rotulo}</span></a>`))}
        </nav>
        <div class="rodape">© ${new Date().getFullYear()} PAY AX · Banqueiro v1.0</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn sm menu-btn" id="menu-btn" aria-label="Menu">${icone('menu')}</button>
          <div class="titulo"><h1 id="titulo-pagina"></h1></div>
          <button class="btn sm" id="tema" title="Alternar tema" aria-label="Alternar tema">${icone('lua')}</button>
          <div class="usuario">
            <div class="nome right"><div style="font-weight:650">${u.nome}</div><div class="small muted">${PERFIL[u.perfil]}</div></div>
            <button class="avatar" id="avatar" style="border:0;cursor:pointer" title="Minha conta">${iniciais(u.nome)}</button>
            <button class="btn sm" id="sair" title="Sair">${icone('sair')}</button>
          </div>
        </header>
        <main class="content" id="conteudo"></main>
      </div>
    </div>`);
  $('#sair').onclick = sair;
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('aberta');
  $('#avatar').onclick = alterarSenha;
  $('#tema').onclick = () => {
    const atual = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const novo = atual === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = novo;
    try { localStorage.setItem('payax.tema', novo); } catch { /* ignora */ }
  };
}

function alterarSenha() {
  modal({
    titulo: 'Alterar minha senha',
    corpo: html`<div class="form">
      <div class="c12"><label>Senha atual</label><input type="password" name="senha_atual" required autocomplete="current-password"></div>
      <div class="c6"><label>Nova senha</label><input type="password" name="nova_senha" minlength="8" required autocomplete="new-password"></div>
      <div class="c6"><label>Confirmar nova senha</label><input type="password" name="confirmar" required autocomplete="new-password"></div></div>`,
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      if (d.nova_senha !== d.confirmar) throw new Error('As senhas não conferem.');
      await api.post('/auth/senha', d);
      fechar();
      toast('Senha alterada com sucesso.');
    },
  });
}

function sair() {
  sessao.limpar();
  location.hash = '#/login';
  rotear();
}

let geracao = 0;
async function rotear() {
  const [rota = 'painel', id] = location.hash.replace(/^#\/?/, '').split('/');
  if (!sessao.get()?.token) {
    login($('#app'), () => { location.hash = '#/painel'; rotear(); });
    return;
  }
  if (rota === 'login') { location.hash = '#/painel'; return; }
  if (!$('.layout')) renderLayout();
  const item = MENU.find((m) => m.rota === rota);
  const pagina = ROTAS[rota];
  const alvo = $('#conteudo');
  $('#sidebar').classList.remove('aberta');
  $$('.nav a').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === rota));
  if (!pagina || (item && !item.perfis.includes(usuarioAtual().perfil))) {
    definirTitulo('Página não encontrada');
    alvo.innerHTML = String(html`<div class="card vazio">Página não encontrada ou sem permissão. <a href="#/painel">Voltar ao painel</a></div>`);
    return;
  }
  const minha = ++geracao;
  definirTitulo(item?.rotulo ?? '');
  alvo.innerHTML = '<div class="carregando">Carregando…</div>';
  try {
    await pagina({ alvo, id, ativo: () => minha === geracao });
  } catch (err) {
    if (minha !== geracao) return;
    alvo.innerHTML = String(html`<div class="card vazio">Não foi possível carregar: ${err.message}</div>`);
  }
  window.scrollTo(0, 0);
}

try {
  const tema = localStorage.getItem('payax.tema');
  if (tema) document.documentElement.dataset.theme = tema;
} catch { /* ignora */ }

window.addEventListener('hashchange', rotear);
window.addEventListener('payax:sair', () => { $('#app').innerHTML = ''; rotear(); });
rotear();

