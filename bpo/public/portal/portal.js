import { api, sessao, usarChaveSessao } from '../js/api.js';
import { html, raw, $, $$, icone, iniciais, toast, modal, dadosForm, marca, moeda, numero, data, pct, rotuloMes, status, hoje, somarMeses, fimMes } from '../js/ui.js';
import { chat } from '../js/pages/mensagens.js';
import { telaEntrada } from '../js/pages/entrada.js';
import { passos2fa } from '../js/pages/conta.js';
import { enviarDocumento, listaDocumentos, ligarDownloads, historicoAprovacao, APROVACAO } from '../js/pages/comum.js';

usarChaveSessao('bpo.portal');

const MENU = [
  { rota: 'inicio', rotulo: 'Início', icone: 'casa' },
  { rota: 'aprovacoes', rotulo: 'Aprovar pagamentos', icone: 'check' },
  { rota: 'contas', rotulo: 'Contas a pagar e receber', icone: 'transacoes' },
  { rota: 'relatorios', rotulo: 'Relatórios', icone: 'dre' },
  { rota: 'documentos', rotulo: 'Documentos', icone: 'documento' },
  { rota: 'mensagens', rotulo: 'Fale com a equipe', icone: 'conversa' },
];
const eu = () => sessao.get()?.responsavel;
const titulo = (t) => { $('#titulo-pagina').textContent = t; document.title = `${t} · Portal do Cliente Ativa`; };

// ---------- Acesso ----------
function telaLogin(alvo) {
  telaEntrada(alvo, {
    tituloPagina: 'Entrar · Portal do Cliente Ativa',
    titulo: 'Portal do Cliente',
    subtitulo: 'Entre com o e-mail e a senha enviados pela equipe Ativa.',
    chamada: 'Portal do Cliente',
    texto: 'O financeiro da sua empresa, acompanhado de perto.',
    itens: [['check', 'Aprove pagamentos de onde estiver'], ['documento', 'Envie notas, boletos e contratos'], ['dre', 'Consulte saldos, DRE e fluxo de caixa'], ['conversa', 'Converse com a equipe do BPO']],
    rota: '/portal/auth/login',
    rota2fa: '/portal/auth/2fa/login',
    aviso: 'Esqueceu a senha? Peça uma nova à equipe Ativa.',
    troca: raw('É da equipe Ativa? <a href="/">Acesse o sistema da equipe</a>.'),
    aoEntrar: () => rotear(),
  });
}

function telaTrocarSenha(alvo) {
  alvo.innerHTML = String(html`<div class="login"><div class="card" style="width:min(460px,100%);padding:28px">
    <div style="margin-bottom:12px">${marca('clara')}</div><h1>Crie sua senha</h1>
    <p class="muted">Bem-vindo(a), ${eu().nome}. Troque a senha provisória por uma só sua: 8 caracteres ou mais, com letras e números.</p>
    <form id="form" class="stack" style="gap:10px" novalidate><div class="erro-form hidden" id="erro"></div>
      <div><label>Senha provisória</label><input type="password" name="senha_atual" required autocomplete="current-password"></div>
      <div><label>Nova senha</label><input type="password" name="nova_senha" required autocomplete="new-password"></div>
      <div><label>Confirme a nova senha</label><input type="password" name="confirmar" required autocomplete="new-password"></div>
      <button class="btn primario" type="submit">Salvar e entrar</button></form></div></div>`);
  $('#form', alvo).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = dadosForm(e.target);
    try {
      if (d.nova_senha !== d.confirmar) throw new Error('As senhas não conferem.');
      await api.post('/portal/auth/senha', d);
      sessao.set({ ...sessao.get(), responsavel: { ...eu(), precisa_trocar_senha: false } });
      toast('Senha criada.');
      rotear();
    } catch (err) { $('#erro', alvo).textContent = err.message; $('#erro', alvo).classList.remove('hidden'); }
  });
}

// ---------- Layout ----------
function layout() {
  const r = eu();
  $('#app').innerHTML = String(html`<div class="layout">
    <aside class="sidebar" id="sidebar"><div class="brand">${marca('clara')}</div>
      <div class="brand" style="border:0;padding-bottom:0"><span class="produto">Portal do Cliente</span></div>
      <div class="empresa-ativa"><div class="rotulo">Empresa</div><div class="nome">${r.empresa.nome}</div></div>
      <nav class="nav">${MENU.map((m) => html`<a href="#/${m.rota}" data-rota="${m.rota}">${icone(m.icone)}<span>${m.rotulo}</span></a>`)}</nav>
      <div class="rodape">Atendimento Ativa BPO Financeiro</div></aside>
    <div class="main"><header class="topbar"><button class="btn sm menu-btn" id="menu-btn" aria-label="Menu">${icone('menu')}</button>
      <div class="titulo"><h1 id="titulo-pagina"></h1></div>
      <div class="usuario"><div class="nome right"><div style="font-weight:650">${r.nome}</div><div class="small muted">${r.cargo ?? r.empresa.nome}</div></div>
        <button class="avatar" id="avatar" style="border:0;cursor:pointer" title="Minha conta">${iniciais(r.nome)}</button>
        <button class="btn sm" id="sair" title="Sair">${icone('sair')}</button></div></header>
      <main class="content" id="conteudo"></main></div></div>`);
  $('#sair').onclick = () => { sessao.limpar(); location.hash = ''; rotear(); };
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('aberta');
  $('#avatar').onclick = minhaConta;
}

async function minhaConta() {
  const { responsavel: r } = await api.get('/portal/auth/me');
  const { el, fechar } = modal({
    titulo: 'Minha conta',
    corpo: html`<dl class="dl" style="margin-bottom:16px"><div><dt>Nome</dt><dd>${r.nome}</dd></div><div><dt>E-mail</dt><dd>${r.email}</dd></div>
      <div><dt>Aprovação</dt><dd>${r.pode_aprovar ? (r.limite_aprovacao_centavos === -1 ? 'Sem limite' : `Até ${moeda(r.limite_aprovacao_centavos)}`) : 'Não aprova'}</dd></div></dl>
      <div class="card card-body" style="box-shadow:none"><div class="row" style="justify-content:space-between"><div><strong>Verificação em duas etapas</strong>
        <div class="small muted">${r.totp_ativo ? 'Ativa.' : 'Recomendada para quem aprova pagamentos.'}</div></div>
        ${r.totp_ativo ? html`<button class="btn sm perigo" id="desativar">Desativar</button>` : html`<button class="btn sm primario" id="ativar">Ativar</button>`}</div><div id="area-2fa" style="margin-top:12px"></div></div>`,
    rodape: html`<div class="modal-foot"><button class="btn" id="senha">Alterar senha</button><button class="btn" data-cancelar>Fechar</button></div>`,
  });
  $('#ativar', el)?.addEventListener('click', (e) => { e.target.disabled = true; passos2fa($('#area-2fa', el), { prefixo: '/portal/auth', aoAtivar: () => { fechar(); toast('Verificação em duas etapas ativada.'); } }); });
  $('#desativar', el)?.addEventListener('click', () => { fechar(); modal({ titulo: 'Desativar verificação em duas etapas',
    corpo: html`<div class="form"><div class="c6"><label>Senha</label><input type="password" name="senha" required></div><div class="c6"><label>Código</label><input name="codigo" inputmode="numeric" maxlength="6" required></div></div>`,
    aoEnviar: async (f, x) => { await api.post('/portal/auth/2fa/desativar', dadosForm(f)); x(); toast('Desativada.'); } }); });
  $('#senha', el).addEventListener('click', () => { fechar(); modal({ titulo: 'Alterar senha',
    corpo: html`<div class="form"><div class="c12"><label>Senha atual</label><input type="password" name="senha_atual" required></div>
      <div class="c6"><label>Nova senha</label><input type="password" name="nova_senha" required></div><div class="c6"><label>Confirmar</label><input type="password" name="confirmar" required></div></div>`,
    aoEnviar: async (f, x) => { const d = dadosForm(f); if (d.nova_senha !== d.confirmar) throw new Error('As senhas não conferem.'); await api.post('/portal/auth/senha', d); x(); toast('Senha alterada.'); } }); });
}

// ---------- Telas ----------
const telas = {
  async inicio(alvo) {
    const r = await api.get('/portal/resumo');
    alvo.innerHTML = String(html`
      <div class="page-head"><div><h1>Olá, ${eu().nome.split(' ')[0]}</h1><p class="muted">Posição financeira de ${eu().empresa.nome} em ${data(r.hoje)}.</p></div></div>
      ${r.alerta_caixa.falta ? html`<div class="alerta perigo">${icone('escudo')}<div><strong>Atenção ao caixa:</strong> com as contas previstas, o saldo fica negativo em ${data(r.alerta_caixa.data)} (${moeda(r.alerta_caixa.saldo_centavos)}). Fale com a equipe.</div></div>` : ''}
      ${r.aprovacoes_pendentes && eu().pode_aprovar ? html`<div class="alerta aviso">${icone('check')}<div>Há pagamento(s) aguardando sua aprovação. <a href="#/aprovacoes">Ver agora</a></div></div>` : ''}
      ${r.mensagens_nao_lidas ? html`<div class="alerta info">${icone('conversa')}<div>${numero(r.mensagens_nao_lidas)} mensagem(ns) nova(s) da equipe. <a href="#/mensagens">Abrir</a></div></div>` : ''}
      <div class="saldo-hero"><div><div class="rotulo">Saldo em contas</div><div class="valor">${moeda(r.saldo_total_centavos)}</div></div>
        <div class="meta"><div><div class="rotulo">Resultado do mês</div><div style="font-size:20px;font-weight:750">${moeda(r.resultado_mes.lucro_liquido)}</div></div>
          <div><div class="rotulo">Receita do mês</div><div style="font-size:20px;font-weight:750">${moeda(r.resultado_mes.receita_bruta)}</div></div></div></div>
      <div class="grid grid-3" style="margin-top:16px">
        <div class="card kpi vermelho"><div class="rotulo">A pagar nos próximos 7 dias</div><div class="valor">${moeda(r.pagar.hoje.total_centavos + r.pagar.semana.total_centavos)}</div>
          <div class="sub">Vencido: ${moeda(r.pagar.vencidos.total_centavos)}</div></div>
        <div class="card kpi verde"><div class="rotulo">A receber nos próximos 7 dias</div><div class="valor">${moeda(r.receber.hoje.total_centavos + r.receber.semana.total_centavos)}</div>
          <div class="sub">Em atraso: ${moeda(r.receber.vencidos.total_centavos)}</div></div>
        <div class="card kpi"><div class="rotulo">Inadimplência (90 dias)</div><div class="valor">${r.inadimplencia.taxa_90_dias === null ? '—' : pct(r.inadimplencia.taxa_90_dias)}</div>
          <div class="sub">${numero(r.inadimplencia.titulos)} título(s) em atraso</div></div></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Contas bancárias</h2></div><div class="table-wrap"><table><tbody>
        ${r.contas.filter((c) => c.ativo).map((c) => html`<tr><td>${c.descricao} <span class="small muted">${c.banco}</span></td><td class="num"><strong>${moeda(c.saldo_centavos)}</strong></td></tr>`)}</tbody></table></div></div>`);
  },

  async aprovacoes(alvo) {
    let aba = 'pendente';
    alvo.innerHTML = String(html`<div class="page-head"><div><h1>Aprovar pagamentos</h1><p class="muted">Pagamentos conferidos pela equipe Ativa aguardando autorização da empresa.</p></div></div>
      <div class="tabs"><button data-aba="pendente" class="ativo">Aguardando</button><button data-aba="aprovada">Aprovados</button><button data-aba="recusada">Recusados</button></div><div id="lista"></div>`);
    const carregar = async () => {
      const r = await api.get('/portal/aprovacoes', { status: aba });
      $('#lista', alvo).innerHTML = String(html`${!r.pode_aprovar ? html`<div class="alerta info">Seu acesso é de consulta: a aprovação é feita por outro responsável da empresa.</div>` : ''}
        <div class="card"><div class="table-wrap"><table><thead><tr><th>Vencimento</th><th>Pagamento</th><th class="num">Valor</th><th></th></tr></thead><tbody>
        ${r.itens.length ? r.itens.map((l) => html`<tr><td>${data(l.vencimento)}</td><td><strong>${l.descricao}</strong><div class="small muted">${l.contato_nome ?? ''} · ${l.categoria_nome}${l.documentos ? ` · ${l.documentos} documento(s)` : ''}</div></td>
          <td class="num"><strong>${moeda(l.valor_centavos)}</strong></td>
          <td class="right" style="white-space:nowrap"><button class="btn sm" data-ver="${l.id}">Detalhes</button>
            ${aba === 'pendente' && r.pode_aprovar ? (l.dentro_do_limite ? html` <button class="btn sm perigo" data-recusar="${l.id}">Recusar</button> <button class="btn sm primario" data-aprovar="${l.id}">Aprovar</button>`
              : html` <span class="badge warn">Acima do seu limite</span>`) : APROVACAO[l.aprovacao] ?? ''}</td></tr>`)
          : html`<tr><td colspan="4" class="vazio">${aba === 'pendente' ? 'Nenhum pagamento aguardando aprovação.' : 'Nada por aqui.'}</td></tr>`}</tbody></table></div></div>`);
      $$('[data-ver]', alvo).forEach((b) => b.addEventListener('click', async () => {
        const l = await api.get(`/portal/aprovacoes/${b.dataset.ver}`);
        const { el } = modal({ titulo: l.descricao, grande: true, corpo: html`<dl class="dl"><div><dt>Valor</dt><dd>${moeda(l.valor_centavos)}</dd></div><div><dt>Vencimento</dt><dd>${data(l.vencimento)}</dd></div>
          <div><dt>Documento</dt><dd>${l.documento ?? '—'}</dd></div></dl>${l.observacoes ? html`<p class="small">${l.observacoes}</p>` : ''}
          <h3 style="margin:16px 0 8px">Andamento</h3>${historicoAprovacao(l.historico)}<h3 style="margin:16px 0 8px">Documentos</h3>${listaDocumentos(l.documentos)}` });
        ligarDownloads(el, (id) => `/portal/documentos/${id}/arquivo`);
      }));
      const decidir = (id, aprovar) => modal({
        titulo: aprovar ? 'Aprovar pagamento' : 'Recusar pagamento',
        corpo: html`<p style="margin-top:0">${aprovar ? 'Você autoriza a equipe Ativa a efetuar este pagamento.' : 'Explique o motivo para a equipe.'}</p>
          <label>Comentário${aprovar ? ' (opcional)' : ''}</label><textarea name="comentario" ${aprovar ? '' : 'required'}></textarea>`,
        rotuloEnviar: aprovar ? 'Aprovar' : 'Recusar',
        aoEnviar: async (f, x) => { await api.post(`/portal/aprovacoes/${id}/${aprovar ? 'aprovar' : 'recusar'}`, dadosForm(f)); x(); toast(aprovar ? 'Pagamento aprovado.' : 'Pagamento recusado.'); carregar(); },
      });
      $$('[data-aprovar]', alvo).forEach((b) => b.addEventListener('click', () => decidir(b.dataset.aprovar, true)));
      $$('[data-recusar]', alvo).forEach((b) => b.addEventListener('click', () => decidir(b.dataset.recusar, false)));
    };
    $$('[data-aba]', alvo).forEach((b) => b.addEventListener('click', () => { aba = b.dataset.aba; $$('[data-aba]', alvo).forEach((x) => x.classList.toggle('ativo', x === b)); carregar(); }));
    await carregar();
  },

  async contas(alvo) {
    const [pagar, receber] = await Promise.all([api.get('/portal/lancamentos', { tipo: 'pagar' }), api.get('/portal/lancamentos', { tipo: 'receber' })]);
    const tabela = (lista, vazio) => html`<div class="table-wrap"><table><tbody>${lista.length ? lista.map((l) => html`<tr><td>${data(l.vencimento)}</td>
      <td>${l.descricao}<div class="small muted">${l.contato_nome ?? ''}</div></td><td class="num">${moeda(l.valor_centavos)}</td><td>${status(l.situacao)} ${APROVACAO[l.aprovacao] ?? ''}</td></tr>`)
      : html`<tr><td class="vazio">${vazio}</td></tr>`}</tbody></table></div>`;
    alvo.innerHTML = String(html`<div class="page-head"><div><h1>Contas em aberto</h1><p class="muted">O que está programado para pagar e para receber.</p></div></div>
      <div class="grid grid-2" style="align-items:start"><div class="card"><div class="card-head"><h2>A pagar</h2></div>${tabela(pagar, 'Nada a pagar.')}</div>
        <div class="card"><div class="card-head"><h2>A receber</h2></div>${tabela(receber, 'Nada a receber.')}</div></div>`);
  },

  async relatorios(alvo) {
    const dia = hoje();
    const de = `${dia.slice(0, 4)}-01-01`;
    const [d, f] = await Promise.all([api.get('/portal/dre', { de, ate: fimMes(dia) }), api.get('/portal/fluxo-caixa', { de: somarMeses(dia, 0), ate: fimMes(somarMeses(dia, 2)), agrupar: 'mes' })]);
    const val = (l, v) => (l.tipo === 'grupo' ? l.sinal * v : v);
    alvo.innerHTML = String(html`<div class="page-head"><div><h1>Relatórios</h1><p class="muted">DRE do ano e fluxo de caixa previsto, preparados pela equipe Ativa.</p></div></div>
      <div class="card"><div class="card-head"><h2>DRE ${dia.slice(0, 4)} (competência)</h2><span class="small muted">Margem líquida ${d.indicadores.margem_liquida === null ? '—' : pct(d.indicadores.margem_liquida)}</span></div>
        <div class="table-wrap"><table class="tabela-num"><thead><tr><th></th>${d.meses.map((m) => html`<th class="num">${rotuloMes(m)}</th>`)}<th class="num">Total</th></tr></thead><tbody>
        ${d.linhas.map((l) => html`<tr class="${l.tipo === 'subtotal' ? `subtotal${l.destaque ? ' destaque' : ''}` : ''}"><td>${l.rotulo}</td>${d.meses.map((m) => html`<td class="num">${l.valores[m] ? moeda(val(l, l.valores[m])) : '—'}</td>`)}
          <td class="num"><strong>${moeda(val(l, l.total))}</strong></td></tr>`)}</tbody></table></div></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Fluxo de caixa previsto</h2></div><div class="table-wrap"><table class="tabela-num"><thead><tr><th></th>${f.periodos.map((p) => html`<th class="num">${rotuloMes(p.periodo)}</th>`)}</tr></thead><tbody>
        <tr><td>Saldo inicial</td>${f.periodos.map((p) => html`<td class="num">${moeda(p.saldo_inicial)}</td>`)}</tr>
        <tr><td>(+) Entradas</td>${f.periodos.map((p) => html`<td class="num">${moeda(p.entradas_realizadas + p.entradas_previstas)}</td>`)}</tr>
        <tr><td>(−) Saídas</td>${f.periodos.map((p) => html`<td class="num">${moeda(p.saidas_realizadas + p.saidas_previstas)}</td>`)}</tr>
        <tr class="subtotal destaque"><td>Saldo final</td>${f.periodos.map((p) => html`<td class="num ${p.saldo_final < 0 ? 'neg' : ''}">${moeda(p.saldo_final)}</td>`)}</tr></tbody></table></div></div>`);
  },

  async documentos(alvo) {
    const carregar = async () => {
      const lista = await api.get('/portal/documentos');
      alvo.innerHTML = String(html`<div class="page-head"><div><h1>Documentos</h1><p class="muted">Envie notas fiscais, boletos e contratos para a equipe. Os documentos da empresa ficam aqui.</p></div>
        <button class="btn primario" id="enviar">${icone('upload')} Enviar documento</button></div><div class="card">${listaDocumentos(lista)}</div>`);
      ligarDownloads(alvo, (id) => `/portal/documentos/${id}/arquivo`);
      $('#enviar', alvo).addEventListener('click', () => enviarDocumento('/portal/documentos', { aoEnviar: carregar }));
    };
    await carregar();
  },

  async mensagens(alvo) {
    await chat(alvo, { rota: '/portal/mensagens', lado: 'cliente', titulo: 'Conversa com a equipe Ativa', vazio: 'Escreva para a equipe do BPO: dúvidas, pedidos e avisos.' });
  },
};

async function rotear() {
  const app = $('#app');
  if (!sessao.get()?.token) return telaLogin(app);
  if (eu()?.precisa_trocar_senha) return telaTrocarSenha(app);
  if (!$('.layout')) {
    try { sessao.set({ ...sessao.get(), responsavel: (await api.get('/portal/auth/me')).responsavel }); } catch { return; }
    layout();
  }
  const rota = location.hash.replace(/^#\/?/, '') || 'inicio';
  const item = MENU.find((m) => m.rota === rota) ?? MENU[0];
  $$('.nav a').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === item.rota));
  $('#sidebar').classList.remove('aberta');
  titulo(item.rotulo);
  const alvo = $('#conteudo');
  alvo.innerHTML = '<div class="carregando">Carregando…</div>';
  try { await telas[item.rota](alvo); } catch (err) { alvo.innerHTML = String(html`<div class="card vazio">Não foi possível carregar: ${err.message}</div>`); }
}

window.addEventListener('hashchange', rotear);
window.addEventListener('bpo:sair', () => { $('#app').innerHTML = ''; rotear(); });
window.addEventListener('bpo:recarregar', rotear);
rotear();
