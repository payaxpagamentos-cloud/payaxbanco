import { api } from '../api.js';
import { pode, definirTitulo } from '../contexto.js';
import {
  html, $, $$, moeda, documento, telefone, cep, data, status, conta, TIPO_CONTA, modal, confirmar, toast,
  dadosForm, centavos, valorMoedaInput, paginacao, debounce, iniciais,
} from '../ui.js';
import { abrirConta } from './contas.js';

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

export function formCliente(cliente = null, aoSalvar) {
  const c = cliente ?? { tipo: 'PF', status: 'ativo' };
  const editando = Boolean(cliente);
  modal({
    titulo: editando ? `Editar cliente` : 'Novo cliente',
    grande: true,
    rotuloEnviar: editando ? 'Salvar alterações' : 'Cadastrar cliente',
    corpo: html`<div class="form">
      <div class="c3"><label>Tipo</label><select name="tipo" ${editando ? 'disabled' : ''}>
        <option value="PF" ${c.tipo === 'PF' ? 'selected' : ''}>Pessoa Física</option>
        <option value="PJ" ${c.tipo === 'PJ' ? 'selected' : ''}>Pessoa Jurídica</option></select></div>
      <div class="c3"><label data-rot-doc>${c.tipo === 'PJ' ? 'CNPJ' : 'CPF'}</label><input name="documento" data-doc required value="${c.documento ? documento(c.documento) : ''}" ${editando ? 'readonly' : ''}></div>
      <div class="c6"><label data-rot-nome>${c.tipo === 'PJ' ? 'Razão social' : 'Nome completo'}</label><input name="nome" required value="${c.nome ?? ''}"></div>
      <div class="c4"><label>E-mail</label><input name="email" type="email" value="${c.email ?? ''}"></div>
      <div class="c4"><label>Telefone</label><input name="telefone" value="${c.telefone ? telefone(c.telefone) : ''}" placeholder="(00) 00000-0000"></div>
      <div class="c4"><label data-rot-nasc>${c.tipo === 'PJ' ? 'Data de fundação' : 'Data de nascimento'}</label><input name="data_nascimento" type="date" value="${c.data_nascimento ?? ''}"></div>
      <div class="c4"><label data-rot-renda>${c.tipo === 'PJ' ? 'Faturamento mensal (R$)' : 'Renda mensal (R$)'}</label><input name="renda" class="moeda" inputmode="numeric" value="${valorMoedaInput(c.renda_mensal_centavos)}"></div>
      <div class="c4"><label>Status</label><select name="status" ${editando && !pode('admin', 'gerente') ? 'disabled' : ''}>
        ${['ativo', 'inativo', 'bloqueado'].map((s) => html`<option value="${s}" ${c.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`)}</select></div>
      <fieldset><legend>Endereço</legend></fieldset>
      <div class="c3"><label>CEP</label><input name="cep" value="${c.cep ? cep(c.cep) : ''}" placeholder="00000-000"></div>
      <div class="c6"><label>Logradouro</label><input name="logradouro" value="${c.logradouro ?? ''}"></div>
      <div class="c3"><label>Número</label><input name="numero" value="${c.numero ?? ''}"></div>
      <div class="c4"><label>Complemento</label><input name="complemento" value="${c.complemento ?? ''}"></div>
      <div class="c4"><label>Bairro</label><input name="bairro" value="${c.bairro ?? ''}"></div>
      <div class="c3"><label>Cidade</label><input name="cidade" value="${c.cidade ?? ''}"></div>
      <div class="c1" style="grid-column:span 1"><label>UF</label><select name="uf"><option value=""></option>${UFS.map((u) => html`<option ${c.uf === u ? 'selected' : ''}>${u}</option>`)}</select></div>
      <div class="c12"><label>Observações</label><textarea name="observacoes">${c.observacoes ?? ''}</textarea></div>
    </div>`,
    aoAbrir: (el) => {
      const tipo = $('[name=tipo]', el);
      tipo.addEventListener('change', () => {
        const pj = tipo.value === 'PJ';
        $('[data-rot-doc]', el).textContent = pj ? 'CNPJ' : 'CPF';
        $('[data-rot-nome]', el).textContent = pj ? 'Razão social' : 'Nome completo';
        $('[data-rot-nasc]', el).textContent = pj ? 'Data de fundação' : 'Data de nascimento';
        $('[data-rot-renda]', el).textContent = pj ? 'Faturamento mensal (R$)' : 'Renda mensal (R$)';
      });
    },
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      const corpo = { ...d, tipo: d.tipo ?? c.tipo, status: d.status ?? c.status, renda_mensal_centavos: centavos(d.renda) };
      delete corpo.renda;
      const salvo = editando ? await api.put(`/clientes/${c.id}`, corpo) : await api.post('/clientes', corpo);
      fechar();
      toast(editando ? 'Cliente atualizado.' : 'Cliente cadastrado.');
      aoSalvar?.(salvo);
    },
  });
}

export async function listaClientes({ alvo, ativo }) {
  const filtro = { q: '', status: '', tipo: '', pagina: 1 };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Clientes</h1><p class="muted">Cadastro de pessoas físicas e jurídicas.</p></div>
      <button class="btn primario" id="novo">+ Novo cliente</button></div>
    <div class="card">
      <div class="filtros">
        <div class="busca"><input id="q" type="search" placeholder="Buscar por nome, CPF/CNPJ ou e-mail"></div>
        <div class="campo"><select id="tipo"><option value="">Todos os tipos</option><option value="PF">Pessoa Física</option><option value="PJ">Pessoa Jurídica</option></select></div>
        <div class="campo"><select id="st"><option value="">Todos os status</option><option value="ativo">Ativos</option><option value="inativo">Inativos</option><option value="bloqueado">Bloqueados</option></select></div>
      </div>
      <div id="tabela"></div>
    </div>`);

  async function carregar() {
    const r = await api.get('/clientes', { ...filtro, status: filtro.status, limite: 20 });
    if (!ativo()) return;
    const t = $('#tabela', alvo);
    t.innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>Cliente</th><th>Documento</th><th>Contato</th><th>Cidade/UF</th><th class="num">Contas</th><th class="num">Saldo total</th><th>Status</th></tr></thead>
      <tbody>${r.itens.length ? r.itens.map((c) => html`<tr class="clicavel" data-id="${c.id}">
        <td><div class="row" style="flex-wrap:nowrap"><span class="avatar" style="width:30px;height:30px;font-size:11px">${iniciais(c.nome)}</span><div><strong>${c.nome}</strong><div class="small muted">${c.tipo === 'PF' ? 'Pessoa Física' : 'Pessoa Jurídica'}</div></div></div></td>
        <td class="mono">${documento(c.documento)}</td>
        <td>${c.email ?? '—'}<div class="small muted">${telefone(c.telefone)}</div></td>
        <td>${c.cidade ? `${c.cidade}/${c.uf ?? ''}` : '—'}</td>
        <td class="num">${c.contas_ativas}</td><td class="num">${moeda(c.saldo_total_centavos)}</td><td>${status(c.status)}</td></tr>`)
      : html`<tr><td colspan="7" class="vazio">Nenhum cliente encontrado.</td></tr>`}</tbody></table></div>`);
    t.append(paginacao(r, (p) => { filtro.pagina = p; carregar(); }));
    $$('tr[data-id]', t).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/clientes/${tr.dataset.id}`; }));
  }

  $('#q', alvo).addEventListener('input', debounce((e) => { filtro.q = e.target.value; filtro.pagina = 1; carregar(); }));
  $('#tipo', alvo).addEventListener('change', (e) => { filtro.tipo = e.target.value; filtro.pagina = 1; carregar(); });
  $('#st', alvo).addEventListener('change', (e) => { filtro.status = e.target.value; filtro.pagina = 1; carregar(); });
  $('#novo', alvo).onclick = () => formCliente(null, (c) => { location.hash = `#/clientes/${c.id}`; });
  await carregar();
}

export async function detalheCliente({ alvo, id, ativo }) {
  const c = await api.get(`/clientes/${id}`);
  if (!ativo()) return;
  definirTitulo(c.nome);
  const saldo = c.contas.filter((x) => x.status !== 'encerrada').reduce((a, x) => a + x.saldo_centavos, 0);
  const endereco = [c.logradouro, c.numero, c.complemento, c.bairro].filter(Boolean).join(', ');
  alvo.innerHTML = String(html`
    <div class="page-head"><div><a href="#/clientes" class="small">← Clientes</a><h1 style="margin-top:4px">${c.nome}</h1>
      <p class="muted">${c.tipo === 'PF' ? 'CPF' : 'CNPJ'} ${documento(c.documento)} · cliente desde ${data(c.criado_em)} ${status(c.status)}</p></div>
      <div class="row">
        ${pode('admin') && !c.contas.length ? html`<button class="btn perigo" id="excluir">Excluir</button>` : ''}
        <button class="btn" id="editar">Editar cadastro</button>
        <button class="btn primario" id="abrir" ${c.status !== 'ativo' ? html`disabled title="Cliente não está ativo"` : ''}>+ Abrir conta</button></div></div>
    <div class="saldo-hero"><div><div class="rotulo">Saldo consolidado</div><div class="valor">${moeda(saldo)}</div></div>
      <div class="meta"><div><div class="rotulo">Contas</div><strong>${c.contas.length}</strong></div>
      <div><div class="rotulo">Empréstimos ativos</div><strong>${c.emprestimos.filter((e) => e.status === 'ativo').length}</strong></div>
      <div><div class="rotulo">${c.tipo === 'PF' ? 'Renda' : 'Faturamento'}</div><strong>${moeda(c.renda_mensal_centavos)}</strong></div></div></div>
    <div class="grid grid-2-1" style="margin-top:16px">
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Contas</h2></div><div class="table-wrap"><table>
          <thead><tr><th>Agência / Conta</th><th>Tipo</th><th class="num">Saldo</th><th class="num">Limite</th><th>Status</th></tr></thead><tbody>
          ${c.contas.length ? c.contas.map((x) => html`<tr class="clicavel" data-href="#/contas/${x.id}"><td class="mono"><strong>${conta(x)}</strong></td><td>${TIPO_CONTA[x.tipo]}</td>
            <td class="num ${x.saldo_centavos < 0 ? 'neg' : ''}">${moeda(x.saldo_centavos)}</td><td class="num">${moeda(x.limite_centavos)}</td><td>${status(x.status)}</td></tr>`)
            : html`<tr><td colspan="5" class="vazio">Nenhuma conta aberta.</td></tr>`}</tbody></table></div></div>
        <div class="card"><div class="card-head"><h2>Empréstimos</h2></div><div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Contratação</th><th class="num">Valor</th><th class="num">Parcelas</th><th>Status</th></tr></thead><tbody>
          ${c.emprestimos.length ? c.emprestimos.map((e) => html`<tr class="clicavel" data-href="#/emprestimos/${e.id}"><td>#${e.id}</td><td>${data(e.criado_em)}</td><td class="num">${moeda(e.valor_centavos)}</td><td class="num">${e.num_parcelas}× ${moeda(e.valor_parcela_centavos)}</td><td>${status(e.status)}</td></tr>`)
            : html`<tr><td colspan="5" class="vazio">Nenhum empréstimo.</td></tr>`}</tbody></table></div></div>
      </div>
      <div class="card"><div class="card-head"><h2>Dados cadastrais</h2></div><div class="card-body"><dl class="dl" style="grid-template-columns:1fr">
        <div><dt>E-mail</dt><dd>${c.email ?? '—'}</dd></div><div><dt>Telefone</dt><dd>${telefone(c.telefone)}</dd></div>
        <div><dt>${c.tipo === 'PF' ? 'Nascimento' : 'Fundação'}</dt><dd>${data(c.data_nascimento)}</dd></div>
        <div><dt>Endereço</dt><dd>${endereco || '—'}${c.cidade ? html`<br>${c.cidade}/${c.uf ?? ''}` : ''}${c.cep ? html`<br>CEP ${cep(c.cep)}` : ''}</dd></div>
        <div><dt>Observações</dt><dd style="white-space:pre-wrap">${c.observacoes ?? '—'}</dd></div>
        <div><dt>Última atualização</dt><dd>${data(c.atualizado_em)}</dd></div>
      </dl></div></div>
    </div>`);
  $$('tr[data-href]', alvo).forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
  const recarregar = () => detalheCliente({ alvo, id, ativo });
  $('#editar', alvo).onclick = () => formCliente(c, recarregar);
  $('#abrir', alvo).onclick = () => abrirConta(c, (nova) => { location.hash = `#/contas/${nova.id}`; });
  const ex = $('#excluir', alvo);
  if (ex) ex.onclick = async () => {
    if (!(await confirmar('Excluir cliente', `Excluir definitivamente ${c.nome}? Esta ação não pode ser desfeita.`, 'Excluir'))) return;
    try { await api.del(`/clientes/${c.id}`); toast('Cliente excluído.'); location.hash = '#/clientes'; } catch (e) { toast(e.message, 'erro'); }
  };
}
