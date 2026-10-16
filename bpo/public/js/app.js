import { api, sessao } from './api.js';
import { html, $, $$, icone, iniciais, toast, modal, dadosForm, marca, opcoes } from './ui.js';
import { usuarioAtual, definirTitulo, ehAdmin, gestor, empresaAtual } from './contexto.js';
import login from './pages/login.js';
import painel from './pages/painel.js';
import { listaEmpresas, contrato } from './pages/empresas.js';
import tarefas from './pages/tarefas.js';
import usuarios from './pages/usuarios.js';
import auditoria from './pages/auditoria.js';
import visao from './pages/visao.js';
import lancamentos from './pages/lancamentos.js';
import conciliacao from './pages/conciliacao.js';
import fluxo from './pages/fluxo.js';
import dre from './pages/dre.js';
import cadastros from './pages/cadastros.js';
import aprovacoes from './pages/aprovacoes.js';
import cobranca from './pages/cobranca.js';
import documentos from './pages/documentos.js';
import orcamento from './pages/orcamento.js';
import { fechamentoEmpresa, fechamentoCarteira } from './pages/fechamento.js';
import mensagens from './pages/mensagens.js';
import integracoes from './pages/integracoes.js';
import seguranca from './pages/seguranca.js';
import { minhaConta, configurar2fa } from './pages/conta.js';

const MENU = [
  { secao: 'Carteira' },
  { rota: 'painel', rotulo: 'Painel', icone: 'painel' },
  { rota: 'empresas', rotulo: 'Empresas', icone: 'empresa' },
  { rota: 'tarefas', rotulo: 'Tarefas', icone: 'tarefas' },
  { rota: 'fechamento', rotulo: 'Fechamento mensal', icone: 'cadeado' },
  { secao: 'Gestão', gestor: true },
  { rota: 'auditoria', rotulo: 'Auditoria', icone: 'auditoria', gestor: true },
  { rota: 'usuarios', rotulo: 'Usuários', icone: 'usuarios', admin: true },
  { rota: 'seguranca', rotulo: 'Segurança e backups', icone: 'escudo', admin: true },
];
const visivel = (m) => (m.admin ? ehAdmin() : m.gestor ? gestor() : true);

// Menu da empresa em atendimento: #/e/{id}/{rota}
const MENU_EMPRESA = [
  { secao: 'Rotina' },
  { rota: 'visao', rotulo: 'Visão geral', icone: 'casa', pagina: visao },
  { rota: 'pagar', rotulo: 'Contas a pagar', icone: 'pagar', pagina: (ctx) => lancamentos({ ...ctx, tipo: 'pagar' }) },
  { rota: 'receber', rotulo: 'Contas a receber', icone: 'receber', pagina: (ctx) => lancamentos({ ...ctx, tipo: 'receber' }) },
  { rota: 'aprovacoes', rotulo: 'Aprovações', icone: 'check', pagina: aprovacoes, contador: 'aprovacoes' },
  { rota: 'cobranca', rotulo: 'Cobrança', icone: 'conversa', pagina: cobranca },
  { rota: 'conciliacao', rotulo: 'Conciliação bancária', icone: 'conciliar', pagina: conciliacao, contador: 'extrato' },
  { secao: 'Relatórios' },
  { rota: 'fluxo', rotulo: 'Fluxo de caixa', icone: 'fluxo', pagina: fluxo },
  { rota: 'dre', rotulo: 'DRE e centros de custo', icone: 'dre', pagina: dre },
  { rota: 'orcamento', rotulo: 'Orçamento', icone: 'relatorios', pagina: orcamento },
  { secao: 'Empresa' },
  { rota: 'mensagens', rotulo: 'Mensagens', icone: 'ouvidoria', pagina: mensagens, contador: 'mensagens' },
  { rota: 'documentos', rotulo: 'Documentos', icone: 'documento', pagina: documentos },
  { rota: 'fechamento', rotulo: 'Fechamento do mês', icone: 'cadeado', pagina: fechamentoEmpresa },
  { rota: 'cadastros', rotulo: 'Cadastros', icone: 'cadastros', pagina: cadastros },
  { rota: 'integracoes', rotulo: 'Integrações', icone: 'plug', pagina: integracoes },
  { rota: 'contrato', rotulo: 'Contrato e responsáveis', icone: 'empresa', pagina: contrato },
];

const ROTAS = { painel, empresas: listaEmpresas, tarefas, usuarios, auditoria, fechamento: fechamentoCarteira, seguranca };
const PERFIL = { admin: 'Administrador', supervisor: 'Supervisor', analista: 'Analista' };

let empresas = [];

function renderLayout() {
  const u = usuarioAtual();
  $('#app').innerHTML = String(html`
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">${marca('clara')}</div>
        <nav class="nav" id="nav"></nav>
        <div class="rodape">© ${new Date().getFullYear()} Ativa BPO Financeiro v1.0</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn sm menu-btn" id="menu-btn" aria-label="Menu">${icone('menu')}</button>
          <div class="titulo"><h1 id="titulo-pagina"></h1></div>
          <div class="usuario">
            <div class="nome right"><div style="font-weight:650">${u.nome}</div><div class="small muted">${PERFIL[u.perfil]}</div></div>
            <button class="avatar" id="avatar" style="border:0;cursor:pointer" title="Alterar minha senha">${iniciais(u.nome)}</button>
            <button class="btn sm" id="sair" title="Sair">${icone('sair')}</button>
          </div>
        </header>
        <main class="content" id="conteudo"></main>
      </div>
    </div>`);
  $('#sair').onclick = sair;
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('aberta');
  $('#avatar').onclick = () => minhaConta(alterarSenha);
}

function renderMenu(rota, empresaId) {
  const atual = empresaAtual.get();
  // Seção só aparece se tiver algum item visível.
  const itens = [];
  let secao = null;
  for (const m of MENU) {
    if (m.secao) { secao = m; continue; }
    if (!visivel(m)) continue;
    if (secao) { itens.push(secao); secao = null; }
    itens.push(m);
  }
  $('#nav').innerHTML = String(html`
    ${itens.map((m) => (m.secao ? html`<div class="secao">${m.secao}</div>`
      : html`<a href="#/${m.rota}" class="${!empresaId && m.rota === rota ? 'ativo' : ''}">${icone(m.icone)}<span>${m.rotulo}</span></a>`))}
    ${atual ? html`
      <div class="secao">Empresa em atendimento</div>
      <div class="empresa-ativa">
        <div class="rotulo">Atendendo</div>
        <div class="nome">${atual.nome}</div>
        ${empresas.length > 1 ? html`<select id="troca-empresa" aria-label="Trocar empresa">${opcoes(empresas, { selecionado: atual.id, rotulo: 'rotulo' })}</select>` : ''}
      </div>
      ${MENU_EMPRESA.map((m) => (m.secao ? html`<div class="secao sub">${m.secao}</div>`
        : html`<a href="#/e/${atual.id}/${m.rota}" data-rota-empresa="${m.rota}" class="${empresaId && m.rota === rota ? 'ativo' : ''}">${icone(m.icone)}<span>${m.rotulo}</span></a>`))}` : ''}`);
  if (atual) atualizarContadores(atual.id);
  $('.nav a.ativo')?.scrollIntoView({ block: 'nearest' });
  const troca = $('#troca-empresa');
  if (troca) troca.onchange = () => {
    const sub = empresaId ? rota : 'visao';
    location.hash = `#/e/${troca.value}/${sub}`;
  };
}

/** Contadores no menu da empresa: aprovações, extrato a conciliar e mensagens do cliente. */
function atualizarContadores(empresaId) {
  api.get('/painel').then((p) => {
    const e = p.pendencias.find((x) => x.id === Number(empresaId));
    if (!e) return;
    const valores = { aprovacoes: e.aprovacoes, extrato: e.extrato_pendente, mensagens: e.mensagens };
    for (const m of MENU_EMPRESA.filter((x) => x.contador)) {
      const link = $(`.nav a[data-rota-empresa="${m.rota}"]`);
      link?.querySelector('.contador')?.remove();
      if (link && valores[m.contador]) link.insertAdjacentHTML('beforeend', `<span class="contador">${valores[m.contador]}</span>`);
    }
  }).catch(() => {});
}
window.addEventListener('bpo:contadores', () => { const a = empresaAtual.get(); if (a) atualizarContadores(a.id); });

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
  empresaAtual.limpar();
  location.hash = '#/login';
  rotear();
}

async function carregarEmpresas() {
  empresas = (await api.get('/empresas')).filter((e) => e.status !== 'encerrada')
    .map((e) => ({ id: e.id, rotulo: e.nome_fantasia || e.razao_social }));
}
window.addEventListener('bpo:empresas', () => carregarEmpresas().catch(() => {}));

let geracao = 0;
async function rotear() {
  const partes = location.hash.replace(/^#\/?/, '').split('/');
  if (!sessao.get()?.token) {
    login($('#app'), () => { location.hash = '#/painel'; rotear(); });
    return;
  }
  if (partes[0] === 'login' || !partes[0]) { location.hash = '#/painel'; return; }
  if (sessao.get()?.configurar_2fa) {
    configurar2fa($('#app'), { obrigatorio: true, aoConcluir: (token) => { sessao.set({ ...sessao.get(), token, configurar_2fa: false }); rotear(); } });
    return;
  }
  if (!$('.layout')) {
    try {
      const { usuario } = await api.get('/auth/me');
      sessao.set({ ...sessao.get(), usuario });
      await carregarEmpresas();
    } catch { return; }
    renderLayout();
  }
  const alvo = $('#conteudo');
  $('#sidebar').classList.remove('aberta');
  const minha = ++geracao;
  const ativo = () => minha === geracao;

  let pagina, titulo, ctx, rota, empresaId = null;
  if (partes[0] === 'e') {
    empresaId = Number(partes[1]);
    rota = partes[2] || 'visao';
    const item = MENU_EMPRESA.find((m) => m.rota === rota);
    let empresa;
    try {
      empresa = await api.get(`/empresas/${empresaId}`);
    } catch (err) {
      if (!ativo()) return;
      empresaAtual.limpar();
      renderMenu(null, null);
      definirTitulo('Empresa indisponível');
      alvo.innerHTML = String(html`<div class="card vazio">${err.message} <a href="#/empresas">Voltar às empresas</a></div>`);
      return;
    }
    if (!ativo()) return;
    empresaAtual.set({ id: empresa.id, nome: empresa.nome_fantasia || empresa.razao_social });
    pagina = item?.pagina;
    titulo = item ? `${item.rotulo} · ${empresa.nome_fantasia || empresa.razao_social}` : '';
    ctx = { alvo, ativo, empresa, base: `/empresas/${empresa.id}`, id: partes[3] };
  } else {
    rota = partes[0];
    const item = MENU.find((m) => m.rota === rota);
    pagina = item && visivel(item) ? ROTAS[rota] : null;
    titulo = item?.rotulo ?? '';
    ctx = { alvo, ativo, id: partes[1] };
  }
  renderMenu(rota, empresaId);
  if (!pagina) {
    definirTitulo('Página não encontrada');
    alvo.innerHTML = String(html`<div class="card vazio">Página não encontrada ou sem permissão. <a href="#/painel">Voltar ao painel</a></div>`);
    return;
  }
  definirTitulo(titulo);
  alvo.innerHTML = '<div class="carregando">Carregando…</div>';
  try {
    await pagina(ctx);
  } catch (err) {
    if (!ativo()) return;
    alvo.innerHTML = String(html`<div class="card vazio">Não foi possível carregar: ${err.message}</div>`);
  }
  window.scrollTo(0, 0);
}

/** Recarrega a página atual (depois de uma ação). */
window.addEventListener('bpo:recarregar', () => rotear());
window.addEventListener('hashchange', rotear);
window.addEventListener('bpo:sair', () => { $('#app').innerHTML = ''; empresaAtual.limpar(); rotear(); });
rotear();
