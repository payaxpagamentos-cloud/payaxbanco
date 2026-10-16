import { api } from '../api.js';
import { html, $, $$, moeda, moedaSinal, numero, data, documento, telefone, opcoes, modal, dadosForm, toast, centavos, valorMoedaInput, debounce, hoje, inicioMes, confirmar } from '../ui.js';

const ABAS = [['contas', 'Contas bancárias'], ['contatos', 'Fornecedores e clientes'], ['categorias', 'Plano de contas'], ['centros', 'Centros de custo']];
const TIPO_CONTATO = [{ id: 'fornecedor', nome: 'Fornecedor' }, { id: 'cliente', nome: 'Cliente' }, { id: 'ambos', nome: 'Fornecedor e cliente' }];
const ORIGEM = { baixa: 'Baixa', transferencia: 'Transferência', ajuste: 'Ajuste' };

export default async function cadastros({ alvo, ativo, base }) {
  let aba = sessionStorage.getItem('bpo.aba-cadastros') || 'contas';
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Cadastros da empresa</h1><p class="muted">Contas bancárias, fornecedores e clientes, plano de contas e centros de custo.</p></div></div>
    <div class="tabs">${ABAS.map(([k, r]) => html`<button data-aba="${k}">${r}</button>`)}</div>
    <div id="aba"></div>`);
  const telas = { contas, contatos, categorias, centros };
  const abrir = async () => {
    try { sessionStorage.setItem('bpo.aba-cadastros', aba); } catch { /* ignora */ }
    $$('[data-aba]', alvo).forEach((b) => b.classList.toggle('ativo', b.dataset.aba === aba));
    const el = $('#aba', alvo);
    el.innerHTML = '<div class="carregando">Carregando…</div>';
    await telas[aba]({ el, base, ativo, reabrir: abrir });
  };
  $$('[data-aba]', alvo).forEach((b) => b.addEventListener('click', () => { aba = b.dataset.aba; abrir(); }));
  await abrir();
}

// ---------- Contas bancárias, livro caixa, transferências e ajustes ----------
async function contas({ el, base, ativo, reabrir }) {
  const lista = await api.get(`${base}/contas-bancarias`);
  if (!ativo()) return;
  const ativas = lista.filter((c) => c.ativo);
  el.innerHTML = String(html`
    <div class="row" style="justify-content:flex-end;margin-bottom:12px">
      <button class="btn" id="ajuste" ${ativas.length ? '' : 'disabled'}>Ajuste de saldo</button>
      <button class="btn" id="transf" ${ativas.length > 1 ? '' : 'disabled'}>Transferência entre contas</button>
      <button class="btn primario" id="nova">+ Nova conta</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Conta</th><th>Banco</th><th>Saldo inicial</th><th class="num">Saldo atual</th><th>Extrato</th><th></th></tr></thead><tbody>
      ${lista.length ? lista.map((c) => html`<tr><td><strong>${c.descricao}</strong>${c.ativo ? '' : html` <span class="badge">Inativa</span>`}</td>
        <td>${c.banco}<div class="small muted">${[c.agencia && `Ag. ${c.agencia}`, c.numero && `C/C ${c.numero}`].filter(Boolean).join(' · ')}</div></td>
        <td>${moeda(c.saldo_inicial_centavos)}<div class="small muted">em ${data(c.data_saldo_inicial)}</div></td>
        <td class="num"><strong class="${c.saldo_centavos < 0 ? 'neg' : ''}">${moeda(c.saldo_centavos)}</strong></td>
        <td>${c.extrato_pendente ? html`<span class="badge warn">${numero(c.extrato_pendente)} a conciliar</span>` : html`<span class="badge ok">Em dia</span>`}</td>
        <td class="right" style="white-space:nowrap"><button class="btn sm" data-livro="${c.id}">Movimentos</button> <button class="btn sm" data-editar="${c.id}">Editar</button></td></tr>`)
        : html`<tr><td colspan="6" class="vazio">Cadastre a primeira conta bancária da empresa, com o saldo na data de início do BPO.</td></tr>`}
    </tbody></table></div></div>`);

  const form = (c = {}) => html`<div class="form">
    <div class="c6"><label>Descrição</label><input name="descricao" required value="${c.descricao ?? ''}" placeholder="Ex.: Conta movimento"></div>
    <div class="c6"><label>Banco</label><input name="banco" required value="${c.banco ?? ''}"></div>
    <div class="c4"><label>Agência</label><input name="agencia" value="${c.agencia ?? ''}"></div>
    <div class="c4"><label>Conta</label><input name="numero" value="${c.numero ?? ''}"></div>
    <div class="c4"><label>Situação</label><select name="ativo"><option value="1">Ativa</option><option value="0" ${c.ativo === 0 ? 'selected' : ''}>Inativa</option></select></div>
    <div class="c6"><label>Saldo inicial (R$)</label><input name="saldo" class="moeda" inputmode="numeric" value="${valorMoedaInput(Math.abs(c.saldo_inicial_centavos ?? 0))}"></div>
    <div class="c2"><label>Sinal</label><select name="negativo"><option value="0">+</option><option value="1" ${(c.saldo_inicial_centavos ?? 0) < 0 ? 'selected' : ''}>−</option></select></div>
    <div class="c4"><label>Na data</label><input name="data_saldo_inicial" type="date" value="${c.data_saldo_inicial ?? hoje()}"></div>
  </div>`;
  const corpo = (f) => {
    const d = dadosForm(f);
    return { descricao: d.descricao, banco: d.banco, agencia: d.agencia, numero: d.numero, ativo: d.ativo === '1',
      saldo_inicial_centavos: centavos(d.saldo) * (d.negativo === '1' ? -1 : 1), data_saldo_inicial: d.data_saldo_inicial };
  };
  $('#nova', el).addEventListener('click', () => modal({
    titulo: 'Nova conta bancária', corpo: form(),
    aoEnviar: async (f, fechar) => { await api.post(`${base}/contas-bancarias`, corpo(f)); fechar(); toast('Conta cadastrada.'); reabrir(); },
  }));
  $$('[data-editar]', el).forEach((b) => b.addEventListener('click', () => {
    const c = lista.find((x) => x.id === Number(b.dataset.editar));
    modal({
      titulo: `Editar ${c.descricao}`, corpo: form(c),
      aoEnviar: async (f, fechar) => { await api.patch(`${base}/contas-bancarias/${c.id}`, corpo(f)); fechar(); toast('Conta atualizada.'); reabrir(); },
    });
  }));
  $$('[data-livro]', el).forEach((b) => b.addEventListener('click', () => livro(base, Number(b.dataset.livro), reabrir)));
  $('#transf', el).addEventListener('click', () => modal({
    titulo: 'Transferência entre contas',
    corpo: html`<div class="form">
      <div class="c6"><label>De</label><select name="origem_id" required>${opcoes(ativas, { rotulo: 'descricao', vazio: 'Selecione' })}</select></div>
      <div class="c6"><label>Para</label><select name="destino_id" required>${opcoes(ativas, { rotulo: 'descricao', vazio: 'Selecione' })}</select></div>
      <div class="c6"><label>Valor (R$)</label><input name="valor" class="moeda" inputmode="numeric" value="0,00"></div>
      <div class="c6"><label>Data</label><input name="data" type="date" value="${hoje()}"></div>
      <div class="c12"><label>Descrição (opcional)</label><input name="descricao"></div></div>`,
    aoEnviar: async (f, fechar) => {
      const d = dadosForm(f);
      await api.post(`${base}/transferencias`, { ...d, valor_centavos: centavos(d.valor) });
      fechar(); toast('Transferência registrada.'); reabrir();
    },
  }));
  $('#ajuste', el).addEventListener('click', () => modal({
    titulo: 'Ajuste de saldo',
    corpo: html`<p class="muted" style="margin-top:0">Use só para corrigir diferenças sem documento (o ideal é lançar a conta a pagar ou a receber). Fica na auditoria.</p><div class="form">
      <div class="c6"><label>Conta</label><select name="conta_bancaria_id" required>${opcoes(ativas, { rotulo: 'descricao' })}</select></div>
      <div class="c6"><label>Data</label><input name="data" type="date" value="${hoje()}"></div>
      <div class="c6"><label>Valor (R$)</label><input name="valor" class="moeda" inputmode="numeric" value="0,00"></div>
      <div class="c6"><label>Direção</label><select name="direcao"><option value="1">Entrada (+)</option><option value="-1">Saída (−)</option></select></div>
      <div class="c12"><label>Motivo</label><input name="descricao" required></div></div>`,
    aoEnviar: async (f, fechar) => {
      const d = dadosForm(f);
      await api.post(`${base}/ajustes`, { conta_bancaria_id: d.conta_bancaria_id, data: d.data, descricao: d.descricao, valor_centavos: centavos(d.valor) * Number(d.direcao) });
      fechar(); toast('Ajuste registrado.'); reabrir();
    },
  }));
}

/** Livro caixa da conta, com saldo linha a linha. */
async function livro(base, contaId, reabrir) {
  const estado = { de: inicioMes(hoje()), ate: hoje() };
  const { el } = modal({ titulo: 'Movimentos da conta', grande: true, corpo: html`<div class="row" style="margin-bottom:12px">
    <div><label>De</label><input type="date" data-f="de" value="${estado.de}"></div><div><label>Até</label><input type="date" data-f="ate" value="${estado.ate}"></div></div><div id="livro"></div>` });
  const carregar = async () => {
    const r = await api.get(`${base}/contas-bancarias/${contaId}/movimentos`, estado);
    $('#livro', el).innerHTML = String(html`<div class="table-wrap"><table><thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th><th class="num">Saldo</th><th></th></tr></thead><tbody>
      <tr><td colspan="3" class="muted">Saldo anterior</td><td class="num">${moeda(r.saldo_anterior_centavos)}</td><td></td></tr>
      ${r.itens.map((m) => html`<tr><td>${data(m.data)}</td><td>${m.descricao}<div class="small muted">${ORIGEM[m.origem]}${m.categoria ? ` · ${m.categoria}` : ''}${m.extrato_id ? ' · conciliado' : ''}</div></td>
        <td class="num">${moedaSinal(m.valor_centavos)}</td><td class="num">${moeda(m.saldo_centavos)}</td>
        <td class="right">${m.origem !== 'baixa' && !m.extrato_id ? html`<button class="btn sm perigo" data-excluir="${m.id}" title="Excluir">Excluir</button>` : ''}</td></tr>`)}
      <tr class="subtotal"><td colspan="3"><strong>Saldo final</strong></td><td class="num"><strong>${moeda(r.saldo_final_centavos)}</strong></td><td></td></tr>
    </tbody></table></div>`);
    $$('[data-excluir]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmar('Excluir movimento', 'Transferências são excluídas nas duas contas.', 'Excluir'))) return;
      try { await api.del(`${base}/movimentos/${b.dataset.excluir}`); toast('Movimento excluído.'); carregar(); reabrir(); } catch (err) { toast(err.message, 'erro'); }
    }));
  };
  $$('[data-f]', el).forEach((i) => i.addEventListener('change', () => { estado[i.dataset.f] = i.value; carregar(); }));
  await carregar();
}

// ---------- Fornecedores e clientes ----------
async function contatos({ el, base, ativo }) {
  const filtros = { busca: '', tipo: '' };
  el.innerHTML = String(html`<div class="card"><div class="filtros">
      <input class="busca" id="busca" placeholder="Nome ou CPF/CNPJ">
      <select class="campo" id="tipo"><option value="">Todos</option><option value="fornecedor">Fornecedores</option><option value="cliente">Clientes</option></select>
      <button class="btn primario" id="novo">+ Novo contato</button></div><div class="table-wrap" id="tabela"></div></div>`);
  let lista = [];
  const form = (c = {}) => html`<div class="form">
    <div class="c8"><label>Nome / razão social</label><input name="nome" required value="${c.nome ?? ''}"></div>
    <div class="c4"><label>Tipo</label><select name="tipo">${opcoes(TIPO_CONTATO, { selecionado: c.tipo ?? 'fornecedor' })}</select></div>
    <div class="c6"><label>CPF/CNPJ</label><input name="documento" data-doc value="${c.documento ? documento(c.documento) : ''}"></div>
    <div class="c6"><label>Chave PIX</label><input name="chave_pix" value="${c.chave_pix ?? ''}"></div>
    <div class="c6"><label>E-mail</label><input name="email" type="email" value="${c.email ?? ''}"></div>
    <div class="c6"><label>Telefone</label><input name="telefone" value="${c.telefone ? telefone(c.telefone) : ''}"></div>
    ${c.id ? html`<div class="c6"><label>Situação</label><select name="ativo"><option value="1">Ativo</option><option value="0" ${c.ativo ? '' : 'selected'}>Inativo</option></select></div>` : ''}
    <div class="c12"><label>Observações</label><textarea name="observacoes">${c.observacoes ?? ''}</textarea></div></div>`;
  const corpo = (f) => { const d = dadosForm(f); return { ...d, ativo: d.ativo === undefined ? true : d.ativo === '1' }; };
  const carregar = async () => {
    lista = await api.get(`${base}/contatos`, filtros);
    if (!ativo()) return;
    $('#tabela', el).innerHTML = String(html`<table><thead><tr><th>Nome</th><th>Tipo</th><th>CPF/CNPJ</th><th>Contato</th><th>PIX</th><th></th></tr></thead><tbody>
      ${lista.length ? lista.map((c) => html`<tr><td><strong>${c.nome}</strong>${c.ativo ? '' : html` <span class="badge">Inativo</span>`}</td>
        <td>${TIPO_CONTATO.find((t) => t.id === c.tipo).nome}</td><td>${c.documento ? documento(c.documento) : '—'}</td>
        <td class="small">${c.email ?? ''}${c.telefone ? html`<div>${telefone(c.telefone)}</div>` : ''}</td><td class="small">${c.chave_pix ?? '—'}</td>
        <td class="right"><button class="btn sm" data-editar="${c.id}">Editar</button></td></tr>`)
        : html`<tr><td colspan="6" class="vazio">Nenhum contato.</td></tr>`}</tbody></table>`);
    $$('[data-editar]', el).forEach((b) => b.addEventListener('click', () => {
      const c = lista.find((x) => x.id === Number(b.dataset.editar));
      modal({ titulo: `Editar ${c.nome}`, corpo: form(c), aoEnviar: async (f, fechar) => { await api.patch(`${base}/contatos/${c.id}`, corpo(f)); fechar(); toast('Contato atualizado.'); carregar(); } });
    }));
  };
  $('#busca', el).addEventListener('input', debounce((e) => { filtros.busca = e.target.value; carregar(); }));
  $('#tipo', el).addEventListener('change', (e) => { filtros.tipo = e.target.value; carregar(); });
  $('#novo', el).addEventListener('click', () => modal({
    titulo: 'Novo fornecedor ou cliente', corpo: form(),
    aoEnviar: async (f, fechar) => { await api.post(`${base}/contatos`, corpo(f)); fechar(); toast('Contato cadastrado.'); carregar(); },
  }));
  await carregar();
}

// ---------- Plano de contas ----------
async function categorias({ el, base, ativo, reabrir }) {
  const { grupos, itens } = await api.get(`${base}/categorias`);
  if (!ativo()) return;
  const rotuloGrupo = Object.fromEntries(grupos.map((g) => [g.chave, g.rotulo]));
  const opcoesGrupo = (tipo, sel) => opcoes(grupos.filter((g) => g.tipo === tipo || g.tipo === null).map((g) => ({ id: g.chave, nome: g.rotulo })), { selecionado: sel });
  const tabela = (tipo, titulo) => html`<div class="card"><div class="card-head"><h2>${titulo}</h2></div><div class="table-wrap"><table><thead><tr><th>Categoria</th><th>Linha da DRE</th><th class="num">Lançamentos</th><th></th></tr></thead><tbody>
    ${itens.filter((c) => c.tipo === tipo).map((c) => html`<tr><td>${c.nome}${c.ativo ? '' : html` <span class="badge">Inativa</span>`}</td><td class="small">${rotuloGrupo[c.grupo_dre]}</td>
      <td class="num">${numero(c.uso)}</td><td class="right"><button class="btn sm" data-editar="${c.id}">Editar</button></td></tr>`)}</tbody></table></div></div>`;
  el.innerHTML = String(html`<div class="row" style="justify-content:space-between;margin-bottom:12px"><span class="muted small">A linha da DRE define onde a categoria aparece no resultado. "Fora da DRE" afeta só o caixa.</span>
    <button class="btn primario" id="nova">+ Nova categoria</button></div>
    <div class="grid grid-2" style="align-items:start">${tabela('receita', 'Receitas')}${tabela('despesa', 'Despesas')}</div>`);
  const form = (c = { tipo: 'despesa' }) => html`<div class="form">
    <div class="c12"><label>Nome</label><input name="nome" required value="${c.nome ?? ''}"></div>
    <div class="c4"><label>Tipo</label><select name="tipo" id="tipo-cat" ${c.uso ? 'disabled' : ''}><option value="receita" ${c.tipo === 'receita' ? 'selected' : ''}>Receita</option><option value="despesa" ${c.tipo === 'despesa' ? 'selected' : ''}>Despesa</option></select></div>
    <div class="c8"><label>Linha da DRE</label><select name="grupo_dre" id="grupo-cat">${opcoesGrupo(c.tipo, c.grupo_dre)}</select></div>
    ${c.id ? html`<div class="c6"><label>Situação</label><select name="ativo"><option value="1">Ativa</option><option value="0" ${c.ativo ? '' : 'selected'}>Inativa</option></select></div>` : ''}</div>`;
  const ligarTipo = (m) => $('#tipo-cat', m).addEventListener('change', (e) => { $('#grupo-cat', m).innerHTML = String(opcoesGrupo(e.target.value)); });
  const corpo = (f, c = {}) => { const d = dadosForm(f); return { ...d, tipo: d.tipo ?? c.tipo, ativo: d.ativo === undefined ? true : d.ativo === '1' }; };
  $('#nova', el).addEventListener('click', () => modal({
    titulo: 'Nova categoria', corpo: form(), aoAbrir: ligarTipo,
    aoEnviar: async (f, fechar) => { await api.post(`${base}/categorias`, corpo(f)); fechar(); toast('Categoria criada.'); reabrir(); },
  }));
  $$('[data-editar]', el).forEach((b) => b.addEventListener('click', () => {
    const c = itens.find((x) => x.id === Number(b.dataset.editar));
    modal({ titulo: `Editar ${c.nome}`, corpo: form(c), aoAbrir: ligarTipo,
      aoEnviar: async (f, fechar) => { await api.patch(`${base}/categorias/${c.id}`, corpo(f, c)); fechar(); toast('Categoria atualizada.'); reabrir(); } });
  }));
}

// ---------- Centros de custo ----------
async function centros({ el, base, ativo, reabrir }) {
  const lista = await api.get(`${base}/centros`);
  if (!ativo()) return;
  el.innerHTML = String(html`<div class="row" style="justify-content:space-between;margin-bottom:12px"><span class="muted small">Filiais, projetos ou áreas. A DRE pode ser filtrada por centro de custo.</span>
    <button class="btn primario" id="novo">+ Novo centro de custo</button></div>
    <div class="card"><div class="table-wrap"><table><tbody>${lista.map((c) => html`<tr><td>${c.nome}${c.ativo ? '' : html` <span class="badge">Inativo</span>`}</td>
      <td class="right"><button class="btn sm" data-alternar="${c.id}">${c.ativo ? 'Desativar' : 'Reativar'}</button></td></tr>`)}</tbody></table></div></div>`);
  $('#novo', el).addEventListener('click', () => modal({
    titulo: 'Novo centro de custo', corpo: html`<div class="form"><div class="c12"><label>Nome</label><input name="nome" required></div></div>`,
    aoEnviar: async (f, fechar) => { await api.post(`${base}/centros`, dadosForm(f)); fechar(); toast('Centro de custo criado.'); reabrir(); },
  }));
  $$('[data-alternar]', el).forEach((b) => b.addEventListener('click', async () => {
    const c = lista.find((x) => x.id === Number(b.dataset.alternar));
    try { await api.patch(`${base}/centros/${c.id}`, { ativo: !c.ativo }); reabrir(); } catch (err) { toast(err.message, 'erro'); }
  }));
}
