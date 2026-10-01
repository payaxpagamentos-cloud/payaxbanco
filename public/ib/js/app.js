import { api, sessao } from './api.js';
import { html, $, $$, icone, toast, iniciais, marca } from '../../js/ui.js';
import { estado, atualizarAvisoGerente } from './comum.js';
import { RAIZ, avisarSite } from './raiz.js';
import { telaLogin, telaPrimeiroAcesso } from './telas/login.js';
import { abrirConta, acompanharProposta } from './telas/abertura.js';
import inicio from './telas/inicio.js';
import pix from './telas/pix.js';
import pagar from './telas/pagar.js';
import transferir from './telas/transferir.js';
import extrato from './telas/extrato.js';
import emprestimos from './telas/emprestimos.js';
import perfil from './telas/perfil.js';
import gerente from './telas/gerente.js';

const MENU = [
  { secao: 'Minha conta' },
  { rota: 'inicio', rotulo: 'Início', icone: 'casa' },
  { rota: 'extrato', rotulo: 'Extrato', icone: 'transacoes' },
  { secao: 'Movimentar' },
  { rota: 'pix', rotulo: 'PIX', icone: 'pix' },
  { rota: 'pagar', rotulo: 'Pagar contas', icone: 'barras' },
  { rota: 'transferir', rotulo: 'Transferir', icone: 'operacoes' },
  { secao: 'Serviços' },
  { rota: 'emprestimos', rotulo: 'Empréstimos', icone: 'emprestimos' },
  { rota: 'gerente', rotulo: 'Meu gerente', icone: 'conversa' },
  { rota: 'perfil', rotulo: 'Meu perfil', icone: 'perfil' },
];
const TELAS = { inicio, pix, pagar, transferir, extrato, emprestimos, perfil, gerente };
const INATIVIDADE_MS = 10 * 60 * 1000;

const app = $('#app');
let temporizador;

function sair(aviso) {
  sessao.limpar();
  estado.me = null;
  estado.resumo = null;
  clearTimeout(temporizador);
  app.innerHTML = '';
  history.replaceState(null, '', location.pathname + location.search);
  const motivo = typeof aviso === 'string' ? aviso : undefined;
  // Por cima do site: "Sair" fecha a janela; sessão expirada volta para a caixa de acesso com o aviso.
  avisarSite(motivo ? 'deslogado' : 'fechar');
  telaLogin(app, entrar, motivo);
}

function reiniciarInatividade() {
  clearTimeout(temporizador);
  temporizador = setTimeout(() => sair('Sessão encerrada por inatividade.'), INATIVIDADE_MS);
}
['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { if (estado.me) reiniciarInatividade(); }, { passive: true }));

async function entrar() {
  estado.me = await api.get('/me');
  if (estado.me.precisa_trocar_senha) {
    telaPrimeiroAcesso(app, estado.me.nome, () => { toast('Tudo pronto! Bem-vindo(a) ao Internet Banking.'); entrar(); }, () => sair());
    return;
  }
  reiniciarInatividade();
  document.body.classList.remove('embutido');
  avisarSite('logado');
  if (!location.hash || location.hash === '#/') location.hash = '#/inicio';
  rotear();
}

/** Layout web: menu na lateral esquerda (mesmo padrão do Banqueiro). */
function layout() {
  const me = estado.me;
  const nome = me.tipo === 'PJ' ? me.nome : me.nome.split(' ')[0];
  app.innerHTML = String(html`
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">${marca('escura')}</div>
        <div class="brand" style="border:0;padding-bottom:0"><span class="produto">Internet Banking</span></div>
        <nav class="nav" aria-label="Menu">
          ${MENU.map((m) => (m.secao ? html`<div class="secao">${m.secao}</div>`
            : html`<a href="#/${m.rota}" data-rota="${m.rota}">${icone(m.icone)}<span>${m.rotulo}</span></a>`))}
        </nav>
        <div class="rodape">Sessão encerrada após 10 min sem uso.<br>© ${new Date().getFullYear()} PAY AX</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn sm menu-btn" id="menu-btn" aria-label="Menu">${icone('menu')}</button>
          <div class="titulo"><h1 id="titulo-pagina"></h1></div>
          <div class="usuario">
            <div class="nome right"><div style="font-weight:650">Olá, ${nome}</div><div class="small muted">${me.documento_mascarado}</div></div>
            <span class="avatar">${iniciais(me.nome)}</span>
            <button class="btn sm" id="sair">${icone('sair')} Sair</button>
          </div>
        </header>
        <main class="content ib-conteudo" id="conteudo"></main>
      </div>
    </div>`);
  $('#sair').onclick = () => sair();
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('aberta');
}

async function rotear() {
  if (!estado.me) return;
  if (!$('.ib-conteudo')) layout();
  const [rota = 'inicio', sub] = location.hash.replace(/^#\/?/, '').split('/');
  const tela = TELAS[rota] ?? inicio;
  $('#sidebar').classList.remove('aberta');
  if (rota !== 'gerente') atualizarAvisoGerente();
  $$('[data-rota]').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === (TELAS[rota] ? rota : 'inicio')));
  const rotulo = MENU.find((m) => m.rota === (TELAS[rota] ? rota : 'inicio'))?.rotulo ?? 'Início';
  document.title = `${rotulo} · Internet Banking PAY AX`;
  $('#titulo-pagina').textContent = rotulo;
  const alvo = $('#conteudo');
  alvo.innerHTML = '<div class="carregando">Carregando…</div>';
  try {
    await (rota === 'perfil' ? perfil(alvo, () => sair()) : tela(alvo, sub));
  } catch (err) {
    if (err.status === 401) return;
    alvo.innerHTML = String(html`<div class="card vazio">Não foi possível carregar: ${err.message}</div>`);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', rotear);
window.addEventListener('payax-ib:sair', (e) => sair(e.detail));

if (sessao.get()?.token) entrar().catch(() => sair());
else {
  telaLogin(app, entrar);
  // Links do site institucional: #/abrir-conta e #/acompanhar abrem direto o assistente ou a consulta.
  if (location.hash === '#/abrir-conta') abrirConta();
  if (location.hash === '#/acompanhar') acompanharProposta();
}
