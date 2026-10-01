import { api } from '../api.js';
import { pode, definirTitulo, semAlcada, usuarioAtual, ehAdmin } from '../contexto.js';
import { avisoAnalise } from './ouvidoria.js';
import {
  html, $, $$, moeda, moedaSinal, documento, dataHora, data, status, conta, TIPO_CONTA, TIPO_TRANSACAO,
  modal, confirmar, toast, dadosForm, centavos, valorMoedaInput, paginacao, debounce,
} from '../ui.js';
import { seletor, ligarSeletor } from './seletores.js';
import { baloes, rolarFim } from '../chat.js';
import { ligarContagens, restante } from '../prazo.js';
import { abrirConversa } from './relacionamento.js';

export function abrirConta(cliente, aoSalvar) {
  modal({
    titulo: 'Abrir nova conta',
    rotuloEnviar: 'Abrir conta',
    corpo: html`<div class="form">
      <div class="c12">${cliente
        ? html`<label>Titular</label><input value="${cliente.nome} · ${documento(cliente.documento)}" readonly><input type="hidden" name="cliente_id" value="${cliente.id}">`
        : seletor('cliente_id', 'Titular', 'Buscar cliente por nome ou documento')}</div>
      <div class="c6"><label>Tipo de conta</label><select name="tipo">
        ${Object.entries(TIPO_CONTA).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
      <div class="c6"><label>Limite de cheque especial (R$)</label><input name="limite" class="moeda" inputmode="numeric" value="0,00" ${pode('contas.limite') ? '' : 'readonly'}>
        <div class="ajuda">${pode('contas.limite') ? 'Não se aplica a poupança.' : 'Seu perfil não tem alçada para conceder limite.'}</div></div>
      ${pode('contas.gerente') ? html`<div class="c12"><label for="nc-gerente">Gerente de relacionamento</label>
        <select id="nc-gerente" name="gerente_id"><option value="">${usuarioAtual().perfil === 'gerente' ? 'Eu mesmo' : 'Sem gerente'}</option></select></div>` : ''}
      <div class="c12 ajuda">Agência e número são gerados automaticamente (dígito verificador módulo 11).</div>
    </div>`,
    aoAbrir: (el) => {
      if (!cliente) ligarSeletor(el, 'cliente_id', 'cliente');
      const sel = $('#nc-gerente', el);
      if (sel) api.get('/relacionamento/gerentes').then((gs) => {
        sel.insertAdjacentHTML('beforeend', String(html`${gs.filter((g) => g.id !== usuarioAtual().id).map((g) => html`<option value="${g.id}">${g.nome}</option>`)}`));
      }).catch(() => {});
    },
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      if (!d.cliente_id) throw new Error('Selecione o titular.');
      const nova = await api.post('/contas', { cliente_id: Number(d.cliente_id), tipo: d.tipo, limite_centavos: centavos(d.limite), ...(d.gerente_id ? { gerente_id: Number(d.gerente_id) } : {}) });
      fechar();
      toast(`Conta ${nova.numero}-${nova.digito} aberta com sucesso.`);
      aoSalvar?.(nova);
    },
  });
}

export async function listaContas({ alvo, ativo }) {
  const filtro = { q: '', status: '', tipo: '', pagina: 1 };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Contas</h1><p class="muted">Contas correntes, poupança, pagamento e salário.</p></div>
      <button class="btn primario" id="nova" ${semAlcada('contas.abrir')}>+ Abrir conta</button></div>
    <div class="card">
      <div class="filtros">
        <div class="busca"><input id="q" type="search" placeholder="Buscar por número, titular ou documento"></div>
        <div class="campo"><select id="tipo"><option value="">Todos os tipos</option>${Object.entries(TIPO_CONTA).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
        <div class="campo"><select id="st"><option value="">Todos os status</option><option value="ativa">Ativas</option><option value="bloqueada">Bloqueadas</option><option value="encerrada">Encerradas</option></select></div>
      </div>
      <div id="tabela"></div>
    </div>`);
  async function carregar() {
    const r = await api.get('/contas', { ...filtro, limite: 20 });
    if (!ativo()) return;
    const t = $('#tabela', alvo);
    t.innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>Agência / Conta</th><th>Titular</th><th>Tipo</th><th>Gerente</th><th class="num">Saldo</th><th class="num">Limite</th><th>Abertura</th><th>Status</th></tr></thead>
      <tbody>${r.itens.length ? r.itens.map((c) => html`<tr class="clicavel" data-id="${c.id}">
        <td class="mono"><strong>${conta(c)}</strong></td><td>${c.cliente_nome}<div class="small muted">${documento(c.cliente_documento)}</div></td>
        <td>${TIPO_CONTA[c.tipo]}</td><td>${c.gerente_nome ?? html`<span class="muted">—</span>`}</td><td class="num ${c.saldo_centavos < 0 ? 'neg' : ''}">${moeda(c.saldo_centavos)}</td>
        <td class="num">${moeda(c.limite_centavos)}</td><td>${data(c.aberta_em)}</td><td>${status(c.status)}</td></tr>`)
      : html`<tr><td colspan="8" class="vazio">Nenhuma conta encontrada.</td></tr>`}</tbody></table></div>`);
    t.append(paginacao(r, (p) => { filtro.pagina = p; carregar(); }));
    $$('tr[data-id]', t).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/contas/${tr.dataset.id}`; }));
  }
  $('#q', alvo).addEventListener('input', debounce((e) => { filtro.q = e.target.value; filtro.pagina = 1; carregar(); }));
  $('#tipo', alvo).addEventListener('change', (e) => { filtro.tipo = e.target.value; filtro.pagina = 1; carregar(); });
  $('#st', alvo).addEventListener('change', (e) => { filtro.status = e.target.value; filtro.pagina = 1; carregar(); });
  $('#nova', alvo).onclick = () => abrirConta(null, (c) => { location.hash = `#/contas/${c.id}`; });
  await carregar();
}

export function estornar(transacao, aoConcluir) {
  modal({
    titulo: `Estornar transação #${transacao.id}`,
    rotuloEnviar: 'Confirmar estorno',
    corpo: html`<p style="margin-top:0">${TIPO_TRANSACAO[transacao.tipo] ?? transacao.tipo} de <strong>${moeda(Math.abs(transacao.valor_centavos))}</strong> em ${dataHora(transacao.criado_em)}.
      Todos os lançamentos vinculados (origem e destino) serão revertidos.</p>
      <label>Motivo do estorno</label><textarea name="motivo" required></textarea>`,
    aoEnviar: async (form, fechar) => {
      await api.post('/operacoes/estorno', { transacao_id: transacao.id, motivo: form.motivo.value });
      fechar();
      toast('Estorno realizado.');
      aoConcluir?.();
    },
  });
}

export async function detalheConta({ alvo, id, ativo }) {
  const [c, pendentes, hist] = await Promise.all([api.get(`/contas/${id}`), api.get('/ouvidoria', { conta_id: id, status: 'em_analise' }), api.get(`/contas/${id}/historico`)]);
  if (!ativo()) return;
  definirTitulo(`Conta ${c.numero}-${c.digito}`);
  const gestor = pode('operacoes.estornar');
  const operavel = c.status === 'ativa' && c.cliente_status === 'ativo';
  const disponivel = c.saldo_centavos + c.limite_centavos;
  alvo.innerHTML = String(html`
    <div class="page-head"><div><a href="#/contas" class="small">← Contas</a>
      <h1 style="margin-top:4px">${TIPO_CONTA[c.tipo]} ${conta(c)} ${status(c.status)}</h1>
      <p class="muted">Titular: <a href="#/clientes/${c.cliente_id}">${c.cliente_nome}</a> · ${documento(c.cliente_documento)} · aberta em ${data(c.aberta_em)}</p>
      <p class="muted" style="margin-top:2px">Gerente de relacionamento: <strong style="color:var(--text)">${c.gerente_nome ?? 'não definido'}</strong>
        ${pode('contas.gerente') && c.status !== 'encerrada' ? html` · <button class="btn link" id="trocar-gerente">${c.gerente_nome ? 'Alterar' : 'Definir'}</button>` : ''}</p></div>
      <div class="row">
        ${pode('contas.limite') && c.status !== 'encerrada' ? html`<button class="btn" id="limite">Alterar limite</button>` : ''}
        ${pode('contas.status') && c.status !== 'encerrada' && !pendentes.length ? html`
          ${c.status === 'ativa' ? html`<button class="btn perigo" data-status="bloqueada">Bloquear</button>` : html`<button class="btn" data-status="ativa">Desbloquear</button>`}
          <button class="btn perigo" data-status="encerrada">Encerrar</button>` : ''}
      </div></div>
    ${pendentes.map((s) => html`<a class="card card-body row" href="#/ouvidoria" style="margin-bottom:16px;background:var(--warn-bg);color:var(--warn);font-weight:600;text-decoration:none">
      ${s.tipo_rotulo} em análise na Ouvidoria · protocolo ${s.protocolo}</a>`)}
    <div class="saldo-hero"><div><div class="rotulo">Saldo atual</div><div class="valor">${moeda(c.saldo_centavos)}</div></div>
      <div class="meta"><div><div class="rotulo">Limite</div><strong>${moeda(c.limite_centavos)}</strong></div>
        <div><div class="rotulo">Disponível</div><strong>${moeda(disponivel)}</strong></div>
        <div><div class="rotulo">Chaves PIX</div><strong>${c.chaves_pix.length}</strong></div></div></div>
    ${operavel ? html`<div class="card card-body small muted" style="margin:16px 0">Transferências, PIX e pagamentos são autorizados pelo próprio cliente no Internet Banking.</div>`
      : html`<div class="card card-body" style="margin:16px 0;background:var(--warn-bg);color:var(--warn);font-weight:600">Conta ${c.status}${c.cliente_status !== 'ativo' ? ` / titular ${c.cliente_status}` : ''}: movimentações indisponíveis.</div>`}
    ${painelLimites(c, hist)}
    <div class="grid grid-2" style="margin-bottom:16px">
      ${painelSolicitacoes(hist)}
      ${painelConversas(c, hist)}
    </div>
    <div class="grid grid-2-1">
      <div class="card"><div class="card-head"><h2>Extrato</h2>
        <div class="row"><input type="date" id="inicio" style="width:auto"><input type="date" id="fim" style="width:auto"></div></div>
        <div id="resumo" class="card-body" style="padding-bottom:0"></div><div id="extrato"></div></div>
      <div class="card"><div class="card-head"><h2>Chaves PIX</h2>${operavel && pode('pix.chaves') ? html`<button class="btn sm" id="nova-chave">+ Nova chave</button>` : ''}</div>
        <div class="table-wrap"><table><tbody>
        ${c.chaves_pix.length ? c.chaves_pix.map((k) => html`<tr><td><span class="badge info">${k.tipo.toUpperCase()}</span></td><td class="mono small" style="word-break:break-all">${k.chave}</td>
          <td class="right"><button class="btn sm perigo" data-del-chave="${k.id}">Remover</button></td></tr>`)
          : html`<tr><td class="vazio">Nenhuma chave cadastrada.</td></tr>`}
        </tbody></table></div></div>
    </div>`);

  const recarregar = () => detalheConta({ alvo, id, ativo });
  const filtro = { pagina: 1, inicio: '', fim: '' };
  async function carregarExtrato() {
    const r = await api.get(`/contas/${id}/extrato`, { ...filtro, limite: 15 });
    if (!ativo()) return;
    $('#resumo', alvo).innerHTML = String(html`<div class="row" style="gap:24px"><span class="muted">Entradas <strong class="pos">${moeda(r.entradas_centavos)}</strong></span>
      <span class="muted">Saídas <strong class="neg">${moeda(Math.abs(r.saidas_centavos))}</strong></span></div>`);
    const t = $('#extrato', alvo);
    t.innerHTML = String(html`<div class="table-wrap"><table><thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th><th class="num">Saldo</th>${gestor ? html`<th></th>` : ''}</tr></thead><tbody>
      ${r.itens.length ? r.itens.map((t) => html`<tr>
        <td class="small">${dataHora(t.criado_em)}</td>
        <td><strong>${TIPO_TRANSACAO[t.tipo] ?? t.tipo}</strong> ${t.estornada_em ? html`<span class="badge warn">estornada</span>` : ''} ${t.canal === 'internet_banking' ? html`<span class="badge info">Internet Banking</span>` : ''}
          <div class="small muted">${t.descricao ?? ''}${t.contraparte_nome ? ` · ${t.contraparte_nome} (${t.contraparte_conta})` : ''}${t.usuario_nome ? ` · por ${t.usuario_nome}` : ''}</div></td>
        <td class="num">${moedaSinal(t.valor_centavos)}</td><td class="num">${moeda(t.saldo_apos_centavos)}</td>
        ${gestor ? html`<td class="right">${!t.estornada_em && !['estorno', 'pagamento'].includes(t.tipo) && !t.tipo.startsWith('emprestimo') && !(t.tipo.startsWith('pix_') && !t.contraparte_conta_id) ? html`<button class="btn sm" data-estornar="${t.id}">Estornar</button>` : ''}</td>` : ''}</tr>`)
        : html`<tr><td colspan="5" class="vazio">Sem lançamentos no período.</td></tr>`}</tbody></table></div>`);
    t.append(paginacao(r, (p) => { filtro.pagina = p; carregarExtrato(); }));
    $$('[data-estornar]', t).forEach((b) => b.addEventListener('click', () => estornar(r.itens.find((x) => String(x.id) === b.dataset.estornar), recarregar)));
  }
  $('#inicio', alvo).addEventListener('change', (e) => { filtro.inicio = e.target.value; filtro.pagina = 1; carregarExtrato(); });
  $('#fim', alvo).addEventListener('change', (e) => { filtro.fim = e.target.value; filtro.pagina = 1; carregarExtrato(); });

  ligarContagens(alvo, recarregar);
  rolarFim($('.chat-compacto', alvo));
  $$('[data-recusar-limite]', alvo).forEach((b) => b.addEventListener('click', () => modal({
    titulo: 'Recusar aumento de limite',
    rotuloEnviar: 'Recusar aumento',
    corpo: html`<p style="margin-top:0">O limite diário do cliente continua como está. O cliente vê o pedido como recusado no Internet Banking.</p>
      <label for="mot-lim">Motivo (registro interno)</label><textarea id="mot-lim" name="motivo"></textarea>`,
    aoEnviar: async (form, fechar) => {
      await api.post(`/contas/limites/pedidos/${b.dataset.recusarLimite}/recusar`, { motivo: form.motivo.value });
      fechar(); toast('Aumento recusado.'); recarregar();
    },
  })));
  const responder = $('#responder-cliente', alvo);
  if (responder) responder.onclick = () => abrirConversa(c.cliente_id, { gerenteId: c.gerente_id ?? null, gerenteNome: c.gerente_nome, aoFechar: recarregar });
  $$('[data-status]', alvo).forEach((b) => b.addEventListener('click', async () => {
    const novo = b.dataset.status;
    const acoes = { bloqueada: 'Bloquear', ativa: 'Desbloquear', encerrada: 'Encerrar' };
    modal({
      titulo: `${acoes[novo]} conta ${c.numero}-${c.digito}`,
      rotuloEnviar: acoes[novo],
      corpo: html`${novo === 'encerrada' ? html`<p style="margin-top:0">O encerramento é definitivo. O saldo deve estar zerado e as chaves PIX serão removidas.</p>` : ''}
        <label>Motivo</label><textarea name="motivo" required></textarea>
        <p class="small muted" style="margin:6px 0 0">Se esta ação exigir análise, ela vai para a Ouvidoria e só é feita depois de aprovada.</p>`,
      aoEnviar: async (form, fechar) => {
        const r = await api.patch(`/contas/${c.id}/status`, { status: novo, motivo: form.motivo.value });
        fechar(); toast(r.em_analise ? avisoAnalise(r.solicitacao) : 'Status da conta atualizado.'); recarregar();
      },
    });
  }));
  const tg = $('#trocar-gerente', alvo);
  if (tg) tg.onclick = async () => {
    const gerentes = await api.get('/relacionamento/gerentes');
    modal({
      titulo: 'Gerente de relacionamento',
      corpo: html`<label for="ger-sel">Gerente da conta ${c.numero}-${c.digito}</label>
        <select id="ger-sel" name="gerente"><option value="">Sem gerente</option>${gerentes.map((g) => html`<option value="${g.id}" ${g.id === c.gerente_id ? 'selected' : ''}>${g.nome}${g.perfil === 'admin' ? ' (administrador)' : ''}</option>`)}</select>
        <p class="small muted" style="margin:8px 0 0">O cliente vê o nome do gerente no Internet Banking e conversa com ele em "Meu gerente".</p>`,
      aoEnviar: async (form, fechar) => {
        await api.patch(`/contas/${c.id}/gerente`, { gerente_id: form.gerente.value || null });
        fechar(); toast('Gerente atualizado.'); recarregar();
      },
    });
  };
  const lim = $('#limite', alvo);
  if (lim) lim.onclick = () => modal({
    titulo: 'Alterar limite',
    corpo: html`<label>Novo limite (R$)</label><input name="limite" class="moeda" inputmode="numeric" value="${valorMoedaInput(c.limite_centavos)}">`,
    aoEnviar: async (form, fechar) => {
      await api.patch(`/contas/${c.id}/limite`, { limite_centavos: centavos(form.limite.value) });
      fechar(); toast('Limite atualizado.'); recarregar();
    },
  });
  const nk = $('#nova-chave', alvo);
  if (nk) nk.onclick = () => novaChavePix(c, recarregar);
  $$('[data-del-chave]', alvo).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmar('Remover chave PIX', 'Deseja remover esta chave PIX?', 'Remover'))) return;
    try { await api.del(`/pix/${b.dataset.delChave}`); toast('Chave removida.'); recarregar(); } catch (e) { toast(e.message, 'erro'); }
  }));
  await carregarExtrato();
}

export function novaChavePix(contaSel, aoSalvar) {
  const pj = contaSel?.cliente_documento?.length === 14;
  modal({
    titulo: 'Cadastrar chave PIX',
    rotuloEnviar: 'Cadastrar chave',
    corpo: html`<div class="form">
      <div class="c12">${contaSel ? html`<label>Conta</label><input readonly value="${conta(contaSel)} · ${contaSel.cliente_nome}"><input type="hidden" name="conta_id" value="${contaSel.id}">`
        : seletor('conta_id', 'Conta', 'Buscar conta por número ou titular')}</div>
      <div class="c6"><label>Tipo de chave</label><select name="tipo" id="tipo-chave">
        <option value="${pj ? 'cnpj' : 'cpf'}">${pj ? 'CNPJ' : 'CPF'} do titular</option>
        ${!contaSel ? html`<option value="cnpj">CNPJ do titular</option>` : ''}
        <option value="email">E-mail</option><option value="telefone">Telefone</option><option value="aleatoria">Chave aleatória</option></select></div>
      <div class="c6" id="campo-chave" style="display:none"><label>Chave</label><input name="chave"></div>
    </div>`,
    aoAbrir: (el) => {
      if (!contaSel) ligarSeletor(el, 'conta_id', 'conta');
      const tipo = $('#tipo-chave', el);
      tipo.addEventListener('change', () => { $('#campo-chave', el).style.display = ['email', 'telefone'].includes(tipo.value) ? '' : 'none'; });
    },
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      if (!d.conta_id) throw new Error('Selecione a conta.');
      const k = await api.post('/pix', { conta_id: Number(d.conta_id), tipo: d.tipo, chave: d.chave });
      fechar();
      toast(`Chave ${k.chave} cadastrada.`);
      aoSalvar?.(k);
    },
  });
}

const STATUS_PEDIDO = { agendado: ['Aguardando prazo', 'warn'], efetivado: ['Em vigor', 'ok'], cancelado: ['Cancelado pelo cliente', ''], recusado: ['Recusado', 'danger'] };
const STATUS_SOL = { em_analise: ['Em análise', 'warn'], aprovada: ['Aprovada', 'ok'], recusada: ['Recusada', 'danger'], cancelada: ['Cancelada', ''] };

/** Todos os limites do titular: cheque especial da conta e limite diário do Internet Banking, com o aumento em andamento. */
function painelLimites(c, hist) {
  const d = hist.limite_diario;
  const p = d?.pedido;
  return html`<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>Limites</h2>
      ${pode('ib.gerenciar') && d ? html`<a class="btn sm" href="#/clientes/${c.cliente_id}">Gerenciar no cadastro</a>` : ''}</div>
    <div class="card-body limites-grade">
      <div><div class="rotulo">Cheque especial (esta conta)</div><strong>${moeda(c.limite_centavos)}</strong>
        <div class="small muted">${c.saldo_centavos < 0 ? `Em uso: ${moeda(-c.saldo_centavos)}` : 'Sem uso no momento'}</div></div>
      ${d ? html`<div><div class="rotulo">Limite diário no Internet Banking</div><strong>${moeda(d.limite_centavos)}</strong>
          <div class="small muted">PIX, transferências e pagamentos do titular</div></div>
        <div><div class="rotulo">Usado hoje</div><strong>${moeda(d.usado_centavos)}</strong>
          <div class="barra-h" style="margin-top:6px"><span style="width:${Math.min(100, (d.usado_centavos / Math.max(1, d.limite_centavos)) * 100).toFixed(1)}%"></span></div></div>
        <div><div class="rotulo">Disponível hoje</div><strong>${moeda(d.disponivel_centavos)}</strong></div>`
        : html`<div class="muted small">O titular ainda não tem acesso ao Internet Banking.</div>`}
    </div>
    ${p ? html`<div class="card-body pedido-limite">
      <div><strong>Aumento pedido pelo cliente: ${moeda(p.valor_atual_centavos)} → ${moeda(p.valor_novo_centavos)}</strong>
        <div class="small muted">Pedido em ${dataHora(p.criado_em)}. Entra em vigor automaticamente em <strong data-prazo-ate="${p.efetiva_em}">${restante(p.efetiva_em)}</strong> (${dataHora(p.efetiva_em)}).</div>
        <div class="barra-h" style="margin-top:8px"><span data-prazo-barra="${p.efetiva_em}" data-desde="${p.criado_em}"></span></div></div>
      ${pode('ib.gerenciar') ? html`<button class="btn sm perigo" data-recusar-limite="${p.id}">Recusar aumento</button>` : ''}</div>` : ''}
  </div>`;
}

function painelSolicitacoes(hist) {
  const itens = [
    ...hist.solicitacoes.map((s) => ({ quando: s.criado_em, titulo: s.tipo_rotulo, detalhe: `${s.protocolo}${s.conta_numero ? ` · conta ${s.conta_numero}` : ''} · ${s.origem === 'cliente' ? 'pedido do cliente' : `por ${s.solicitante_nome ?? 'equipe'}`}`, st: STATUS_SOL[s.status], link: '#/ouvidoria' })),
    ...hist.pedidos_limite.map((x) => ({ quando: x.criado_em, titulo: `Limite diário: ${moeda(x.valor_atual_centavos)} → ${moeda(x.valor_novo_centavos)}`,
      detalhe: x.valor_novo_centavos < x.valor_atual_centavos ? 'Redução pedida pelo cliente (imediata)' : `Aumento pedido pelo cliente${x.motivo ? ` · ${x.motivo}` : ''}`, st: STATUS_PEDIDO[x.status] })),
  ].sort((a, b) => (a.quando < b.quando ? 1 : -1));
  return html`<div class="card"><div class="card-head"><h2>Solicitações</h2><span class="small muted">${itens.length}</span></div>
    <div class="lista-hist">${itens.length ? itens.map((i) => html`<div class="item-hist">
        <div><strong>${i.titulo}</strong><div class="small muted">${i.detalhe}</div><div class="small muted">${dataHora(i.quando)}</div></div>
        <span class="badge ${i.st[1]}">${i.st[0]}</span></div>`) : html`<div class="vazio">Nenhuma solicitação deste cliente.</div>`}</div></div>`;
}

function painelConversas(c, hist) {
  return html`<div class="card"><div class="card-head"><h2>Conversas com o gerente</h2>
      ${pode('relacionamento.atender') && (ehAdmin() || c.gerente_id === usuarioAtual().id) ? html`<button class="btn sm" id="responder-cliente">Responder</button>` : ''}</div>
    <div class="card-body"><div class="chat-lista chat-compacto">${baloes(hist.mensagens, { lado: 'gerente', nomeOutro: c.cliente_nome.split(' ')[0], meuNome: usuarioAtual().nome })}</div></div></div>`;
}
