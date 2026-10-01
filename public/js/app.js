import { api, sessao } from './api.js';
import { html, $, $$, icone, iniciais, toast, modal, dadosForm, marca } from './ui.js';
import { usuarioAtual, definirTitulo, pode, ehAdmin } from './contexto.js';
import login from './pages/login.js';
import dashboard from './pages/dashboard.js';
import { listaClientes, detalheCliente } from './pages/clientes.js';
import { listaContas, detalheConta } from './pages/contas.js';
import pix from './pages/pix.js';
import { listaEmprestimos, detalheEmprestimo } from './pages/emprestimos.js';
import transacoes from './pages/transacoes.js';
import relatorios from './pages/relatorios.js';
import usuarios from './pages/usuarios.js';
import auditoria from './pages/auditoria.js';
import aberturas from './pages/aberturas.js';
import bradesco from './pages/bradesco.js';
import alcadas from './pages/alcadas.js';
import ouvidoria from './pages/ouvidoria.js';

// `alcada`: só aparece para quem tem a permissão; `admin`: exclusivo do administrador.
const MENU = [
  { secao: 'Visão geral' },
  { rota: 'painel', rotulo: 'Painel', icone: 'painel' },
  { secao: 'Cadastro' },
  { rota: 'clientes', rotulo: 'Clientes', icone: 'clientes' },
  { rota: 'aberturas', rotulo: 'Abertura de contas', icone: 'mais' },
  { rota: 'contas', rotulo: 'Contas', icone: 'contas' },
  { rota: 'pix', rotulo: 'Chaves PIX', icone: 'pix' },
  { secao: 'Movimentação' },
  { rota: 'transacoes', rotulo: 'Transações', icone: 'transacoes' },
  { rota: 'emprestimos', rotulo: 'Empréstimos', icone: 'emprestimos' },
  { secao: 'Gestão' },
  { rota: 'ouvidoria', rotulo: 'Ouvidoria', icone: 'ouvidoria' },
  { rota: 'bradesco', rotulo: 'Bradesco', icone: 'banco', alcada: 'bradesco.conciliar' },
  { rota: 'relatorios', rotulo: 'Relatórios', icone: 'relatorios', alcada: 'relatorios.ver' },
  { rota: 'auditoria', rotulo: 'Auditoria', icone: 'auditoria', alcada: 'auditoria.ver' },
  { rota: 'usuarios', rotulo: 'Usuários', icone: 'usuarios', admin: true },
  { rota: 'alcadas', rotulo: 'Alçadas', icone: 'chave', admin: true },
];
const visivel = (m) => (m.admin ? ehAdmin() : !m.alcada || pode(m.alcada));

const ROTAS = {
  painel: dashboard,
  clientes: (ctx) => (ctx.id ? detalheCliente(ctx) : listaClientes(ctx)),
  contas: (ctx) => (ctx.id ? detalheConta(ctx) : listaContas(ctx)),
  pix,
  emprestimos: (ctx) => (ctx.id ? detalheEmprestimo(ctx) : listaEmprestimos(ctx)),
  transacoes,
  relatorios,
  usuarios,
  auditoria,
  bradesco,
  aberturas,
  alcadas,
  ouvidoria,
};

const PERFIL = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador', ouvidoria: 'Ouvidoria' };


function renderLayout() {
  const u = usuarioAtual();
  $('#app').innerHTML = String(html`
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          ${marca('escura')}
        </div>
        <div class="brand" style="border:0;padding-bottom:0"><span class="produto">Banqueiro</span></div>
        <nav class="nav">
          ${MENU.filter((m, i) => (m.secao ? MENU.slice(i + 1).find((x) => x.secao || visivel(x))?.secao === undefined : visivel(m))).map((m) => (m.secao
            ? html`<div class="secao">${m.secao}</div>`
            : html`<a href="#/${m.rota}" data-rota="${m.rota}">${icone(m.icone)}<span>${m.rotulo}</span></a>`))}
        </nav>
        <div class="rodape">© ${new Date().getFullYear()} PAY AX · Banqueiro v1.0</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn sm menu-btn" id="menu-btn" aria-label="Menu">${icone('menu')}</button>
          <div class="titulo"><h1 id="titulo-pagina"></h1></div>
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

function contador(rota, n, titulo) {
  const link = $(`.nav a[data-rota="${rota}"]`);
  if (!link) return;
  link.querySelector('.contador')?.remove();
  if (n) link.insertAdjacentHTML('beforeend', `<span class="contador" title="${titulo}">${n}</span>`);
}

/** Mostra no menu quantas propostas de abertura de conta aguardam análise. */
function atualizarContadorPropostas() {
  if (pode('ouvidoria.decidir')) api.get('/ouvidoria/pendentes').then((r) => contador('ouvidoria', r.total, 'Aguardando análise da Ouvidoria')).catch(() => {});
  api.get('/aberturas', { status: 'em_analise' }).then((lista) => {
    const link = $('.nav a[data-rota="aberturas"]');
    if (!link) return;
    link.querySelector('.contador')?.remove();
    if (lista.length) link.insertAdjacentHTML('beforeend', `<span class="contador" title="Aguardando análise">${lista.length}</span>`);
  }).catch(() => {});
}

let geracao = 0;
async function rotear() {
  const [rota = 'painel', id] = location.hash.replace(/^#\/?/, '').split('/');
  if (!sessao.get()?.token) {
    login($('#app'), () => { location.hash = '#/painel'; rotear(); });
    return;
  }
  if (rota === 'login') { location.hash = '#/painel'; return; }
  if (!$('.layout')) {
    // Alçadas atualizadas pelo administrador valem a partir do próximo carregamento da página.
    try { sessao.set({ ...sessao.get(), ...(await api.get('/auth/me').then(({ permissoes }) => ({ permissoes }))) }); } catch { /* sessão expirada: tratada pela API */ }
    if (!sessao.get()?.token) return;
    renderLayout();
  }
  const item = MENU.find((m) => m.rota === rota);
  const pagina = ROTAS[rota];
  const alvo = $('#conteudo');
  $('#sidebar').classList.remove('aberta');
  $$('.nav a').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === rota));
  atualizarContadorPropostas();
  if (!pagina || (item && !visivel(item))) {
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

window.addEventListener('hashchange', rotear);
window.addEventListener('payax:sair', () => { $('#app').innerHTML = ''; rotear(); });
rotear();

