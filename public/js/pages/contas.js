import { api } from '../api.js';
import { pode, definirTitulo } from '../contexto.js';
import {
  html, $, $$, moeda, moedaSinal, documento, dataHora, data, status, conta, TIPO_CONTA, TIPO_TRANSACAO,
  modal, confirmar, toast, dadosForm, centavos, valorMoedaInput, paginacao, debounce,
} from '../ui.js';
import { seletor, ligarSeletor } from './seletores.js';
import { formOperacao } from './operacoes.js';
import { receberViaPix } from './bradesco.js';

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
      <div class="c6"><label>Limite de cheque especial (R$)</label><input name="limite" class="moeda" inputmode="numeric" value="0,00" ${pode('admin', 'gerente') ? '' : 'readonly'}>
        <div class="ajuda">${pode('admin', 'gerente') ? 'Não se aplica a poupança.' : 'Somente gerentes concedem limite.'}</div></div>
      <div class="c12 ajuda">Agência e número são gerados automaticamente (dígito verificador módulo 11).</div>
    </div>`,
    aoAbrir: (el) => { if (!cliente) ligarSeletor(el, 'cliente_id', 'cliente'); },
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      if (!d.cliente_id) throw new Error('Selecione o titular.');
      const nova = await api.post('/contas', { cliente_id: Number(d.cliente_id), tipo: d.tipo, limite_centavos: centavos(d.limite) });
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
      <button class="btn primario" id="nova">+ Abrir conta</button></div>
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
      <thead><tr><th>Agência / Conta</th><th>Titular</th><th>Tipo</th><th class="num">Saldo</th><th class="num">Limite</th><th>Abertura</th><th>Status</th></tr></thead>
      <tbody>${r.itens.length ? r.itens.map((c) => html`<tr class="clicavel" data-id="${c.id}">
        <td class="mono"><strong>${conta(c)}</strong></td><td>${c.cliente_nome}<div class="small muted">${documento(c.cliente_documento)}</div></td>
        <td>${TIPO_CONTA[c.tipo]}</td><td class="num ${c.saldo_centavos < 0 ? 'neg' : ''}">${moeda(c.saldo_centavos)}</td>
        <td class="num">${moeda(c.limite_centavos)}</td><td>${data(c.aberta_em)}</td><td>${status(c.status)}</td></tr>`)
      : html`<tr><td colspan="7" class="vazio">Nenhuma conta encontrada.</td></tr>`}</tbody></table></div>`);
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
  const c = await api.get(`/contas/${id}`);
  if (!ativo()) return;
  definirTitulo(`Conta ${c.numero}-${c.digito}`);
  const gestor = pode('admin', 'gerente');
  const operavel = c.status === 'ativa' && c.cliente_status === 'ativo';
  const disponivel = c.saldo_centavos + c.limite_centavos;
  alvo.innerHTML = String(html`
    <div class="page-head"><div><a href="#/contas" class="small">← Contas</a>
      <h1 style="margin-top:4px">${TIPO_CONTA[c.tipo]} ${conta(c)} ${status(c.status)}</h1>
      <p class="muted">Titular: <a href="#/clientes/${c.cliente_id}">${c.cliente_nome}</a> · ${documento(c.cliente_documento)} · aberta em ${data(c.aberta_em)}</p></div>
      <div class="row">
        ${gestor && c.status !== 'encerrada' ? html`
          <button class="btn" id="limite">Alterar limite</button>
          ${c.status === 'ativa' ? html`<button class="btn perigo" data-status="bloqueada">Bloquear</button>` : html`<button class="btn" data-status="ativa">Desbloquear</button>`}
          <button class="btn perigo" data-status="encerrada">Encerrar</button>` : ''}
      </div></div>
    <div class="saldo-hero"><div><div class="rotulo">Saldo atual</div><div class="valor">${moeda(c.saldo_centavos)}</div></div>
      <div class="meta"><div><div class="rotulo">Limite</div><strong>${moeda(c.limite_centavos)}</strong></div>
        <div><div class="rotulo">Disponível</div><strong>${moeda(disponivel)}</strong></div>
        <div><div class="rotulo">Chaves PIX</div><strong>${c.chaves_pix.length}</strong></div></div></div>
    ${operavel ? html`<div class="row" style="margin:16px 0">
      <button class="btn ouro" data-op="deposito">Depositar</button><button class="btn" data-op="saque">Sacar</button>
      <button class="btn" data-op="transferencia">Transferir</button><button class="btn" data-op="pix">Enviar PIX</button>
      <button class="btn primario" id="receber-pix">Receber via PIX</button></div>`
      : html`<div class="card card-body" style="margin:16px 0;background:var(--warn-bg);color:var(--warn);font-weight:600">Conta ${c.status}${c.cliente_status !== 'ativo' ? ` / titular ${c.cliente_status}` : ''}: movimentações indisponíveis.</div>`}
    <div class="grid grid-2-1">
      <div class="card"><div class="card-head"><h2>Extrato</h2>
        <div class="row"><input type="date" id="inicio" style="width:auto"><input type="date" id="fim" style="width:auto"></div></div>
        <div id="resumo" class="card-body" style="padding-bottom:0"></div><div id="extrato"></div></div>
      <div class="card"><div class="card-head"><h2>Chaves PIX</h2>${operavel ? html`<button class="btn sm" id="nova-chave">+ Nova chave</button>` : ''}</div>
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

  $$('[data-op]', alvo).forEach((b) => b.addEventListener('click', () => formOperacao(b.dataset.op, c, recarregar)));
  const rp = $('#receber-pix', alvo);
  if (rp) rp.onclick = () => receberViaPix(c, recarregar);
  $$('[data-status]', alvo).forEach((b) => b.addEventListener('click', async () => {
    const novo = b.dataset.status;
    const acoes = { bloqueada: 'Bloquear', ativa: 'Desbloquear', encerrada: 'Encerrar' };
    modal({
      titulo: `${acoes[novo]} conta ${c.numero}-${c.digito}`,
      rotuloEnviar: acoes[novo],
      corpo: html`${novo === 'encerrada' ? html`<p style="margin-top:0">O encerramento é definitivo. O saldo deve estar zerado e as chaves PIX serão removidas.</p>` : ''}
        <label>Motivo</label><textarea name="motivo" required></textarea>`,
      aoEnviar: async (form, fechar) => {
        await api.patch(`/contas/${c.id}/status`, { status: novo, motivo: form.motivo.value });
        fechar(); toast('Status da conta atualizado.'); recarregar();
      },
    });
  }));
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
