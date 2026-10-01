import { api, sessao } from './api.js';
import { html, $, $$, icone, toast } from '../../js/ui.js';
import { estado } from './comum.js';
import { telaLogin, telaPrimeiroAcesso } from './telas/login.js';
import inicio from './telas/inicio.js';
import pix from './telas/pix.js';
import pagar from './telas/pagar.js';
import transferir from './telas/transferir.js';
import extrato from './telas/extrato.js';
import emprestimos from './telas/emprestimos.js';
import perfil from './telas/perfil.js';

const MENU = [
  { rota: 'inicio', rotulo: 'Início', icone: 'casa', baixo: true },
  { rota: 'pix', rotulo: 'PIX', icone: 'pix', baixo: true },
  { rota: 'pagar', rotulo: 'Pagar', icone: 'barras', baixo: true },
  { rota: 'transferir', rotulo: 'Transferir', icone: 'operacoes' },
  { rota: 'extrato', rotulo: 'Extrato', icone: 'transacoes', baixo: true },
  { rota: 'emprestimos', rotulo: 'Empréstimos', icone: 'emprestimos' },
  { rota: 'perfil', rotulo: 'Perfil', icone: 'perfil', baixo: true },
];
const TELAS = { inicio, pix, pagar, transferir, extrato, emprestimos, perfil };
const INATIVIDADE_MS = 10 * 60 * 1000;

const app = $('#app');
let temporizador;

function sair(aviso) {
  sessao.limpar();
  estado.me = null;
  estado.resumo = null;
  clearTimeout(temporizador);
  app.innerHTML = '';
  history.replaceState(null, '', location.pathname);
  telaLogin(app, entrar, typeof aviso === 'string' ? aviso : undefined);
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
  if (!location.hash || location.hash === '#/') location.hash = '#/inicio';
  rotear();
}

function layout() {
  const primeiro = estado.me.nome.split(' ')[0];
  app.innerHTML = String(html`
    <header class="ib-topo">
      <div class="linha">
        <img src="../img/logo-payax-branco.svg" alt="PAY AX">
        <div class="ola">Olá, <strong>${estado.me.tipo === 'PJ' ? estado.me.nome : primeiro}</strong></div>
        <button class="btn sm" id="sair" aria-label="Sair">${icone('sair')}<span class="sair-txt">Sair</span></button>
      </div>
      <nav class="ib-nav" aria-label="Menu">${MENU.map((m) => html`<a href="#/${m.rota}" data-rota="${m.rota}">${icone(m.icone)}${m.rotulo}</a>`)}</nav>
    </header>
    <main class="ib-conteudo" id="conteudo"></main>
    <nav class="ib-baixo" aria-label="Menu principal">${MENU.filter((m) => m.baixo).map((m) => html`<a href="#/${m.rota}" data-rota="${m.rota}">${icone(m.icone)}${m.rotulo}</a>`)}</nav>`);
  $('#sair').onclick = () => sair();
}

async function rotear() {
  if (!estado.me) return;
  if (!$('.ib-conteudo')) layout();
  const [rota = 'inicio', sub] = location.hash.replace(/^#\/?/, '').split('/');
  const tela = TELAS[rota] ?? inicio;
  $$('[data-rota]').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === (TELAS[rota] ? rota : 'inicio')));
  document.title = `${MENU.find((m) => m.rota === rota)?.rotulo ?? 'Início'} · Internet Banking PAY AX`;
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

try {
  const tema = localStorage.getItem('payax.tema');
  if (tema) document.documentElement.dataset.theme = tema;
} catch { /* ignora */ }

window.addEventListener('hashchange', rotear);
window.addEventListener('payax-ib:sair', (e) => sair(e.detail));

if (sessao.get()?.token) entrar().catch(() => sair());
else telaLogin(app, entrar);
