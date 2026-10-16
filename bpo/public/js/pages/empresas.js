import { api } from '../api.js';
import { html, $, moeda, numero, data, documento, telefone, status, modal, dadosForm, toast, centavos, valorMoedaInput, opcoes, linksLinhas, debounce, hoje } from '../ui.js';
import { gestor } from '../contexto.js';

const PLANOS = { essencial: 'Essencial', completo: 'Completo', premium: 'Premium' };
const STATUS = [{ id: 'implantacao', nome: 'Implantação' }, { id: 'ativa', nome: 'Ativa' }, { id: 'suspensa', nome: 'Suspensa' }, { id: 'encerrada', nome: 'Encerrada' }];

/** Formulário de empresa (cadastro e edição do contrato). */
function formEmpresa(e = {}, equipe = []) {
  return html`<div class="form">
    <fieldset><legend>Empresa</legend></fieldset>
    <div class="c8"><label>Razão social</label><input name="razao_social" required value="${e.razao_social ?? ''}"></div>
    <div class="c4"><label>CNPJ</label><input name="cnpj" data-doc required value="${e.cnpj ? documento(e.cnpj) : ''}"></div>
    <div class="c6"><label>Nome fantasia</label><input name="nome_fantasia" value="${e.nome_fantasia ?? ''}"></div>
    <div class="c6"><label>Responsável na empresa</label><input name="responsavel" value="${e.responsavel ?? ''}"></div>
    <div class="c6"><label>E-mail do financeiro</label><input name="email" type="email" value="${e.email ?? ''}"></div>
    <div class="c6"><label>Telefone</label><input name="telefone" value="${e.telefone ? telefone(e.telefone) : ''}"></div>
    <fieldset><legend>Contrato de BPO</legend></fieldset>
    <div class="c6"><label>Analista responsável</label><select name="analista_id">${opcoes(equipe, { selecionado: e.analista_id, vazio: 'Sem analista' })}</select></div>
    <div class="c3"><label>Plano</label><select name="plano">${opcoes(Object.entries(PLANOS).map(([id, nome]) => ({ id, nome })), { selecionado: e.plano ?? 'essencial' })}</select></div>
    <div class="c3"><label>Situação</label><select name="status">${opcoes(STATUS, { selecionado: e.status ?? 'implantacao' })}</select></div>
    <div class="c4"><label>Mensalidade (R$)</label><input name="mensalidade" class="moeda" inputmode="numeric" value="${valorMoedaInput(e.mensalidade_centavos ?? 0)}"></div>
    <div class="c2"><label>Dia venc.</label><input name="dia_vencimento" type="number" min="1" max="28" value="${e.dia_vencimento ?? 10}"></div>
    <div class="c3"><label>Início</label><input name="inicio_contrato" type="date" value="${e.inicio_contrato ?? hoje()}"></div>
    <div class="c3"><label>Fim (opcional)</label><input name="fim_contrato" type="date" value="${e.fim_contrato ?? ''}"></div>
    <div class="c12"><label>Escopo e observações</label><textarea name="observacoes" placeholder="Serviços contratados, acessos bancários, prazos combinados…">${e.observacoes ?? ''}</textarea></div>
  </div>`;
}

const corpoEmpresa = (form) => {
  const d = dadosForm(form);
  return { ...d, mensalidade_centavos: centavos(d.mensalidade), dia_vencimento: Number(d.dia_vencimento), analista_id: d.analista_id || null, fim_contrato: d.fim_contrato || null };
};

export async function novaEmpresa() {
  const equipe = await api.get('/usuarios/equipe');
  modal({
    titulo: 'Nova empresa na carteira',
    grande: true,
    corpo: html`<p class="muted" style="margin-top:0">O plano de contas padrão, o centro de custo "Geral" e as rotinas mensais (conciliação, DRE e programação de pagamentos) são criados automaticamente.</p>${formEmpresa({}, equipe)}`,
    rotuloEnviar: 'Cadastrar empresa',
    aoEnviar: async (form, fechar) => {
      const r = await api.post('/empresas', corpoEmpresa(form));
      fechar();
      toast('Empresa cadastrada.');
      window.dispatchEvent(new Event('bpo:empresas'));
      location.hash = `#/e/${r.id}/cadastros`;
    },
  });
}

export async function listaEmpresas({ alvo, ativo }) {
  const filtros = { status: '', busca: '' };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Empresas atendidas</h1><p class="muted">Carteira de clientes do BPO Financeiro.</p></div>
      ${gestor() ? html`<button class="btn primario" id="nova">+ Nova empresa</button>` : ''}</div>
    <div class="card">
      <div class="filtros">
        <input class="busca" id="busca" placeholder="Buscar por nome ou CNPJ">
        <select class="campo" id="status"><option value="">Todas as situações</option>${opcoes(STATUS)}</select>
      </div>
      <div class="table-wrap" id="tabela"></div>
    </div>`);
  const carregar = async () => {
    const lista = await api.get('/empresas', filtros);
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<table><thead><tr><th>Empresa</th><th>Analista</th><th>Plano</th><th class="num">Mensalidade</th>
      <th>Situação</th><th>Pendências</th></tr></thead><tbody>
      ${lista.length ? lista.map((e) => html`<tr class="clicavel" data-href="#/e/${e.id}/visao">
        <td><strong>${e.nome_fantasia || e.razao_social}</strong><div class="small muted">${e.razao_social !== (e.nome_fantasia || e.razao_social) ? `${e.razao_social} · ` : ''}${documento(e.cnpj)}</div></td>
        <td>${e.analista_nome ?? html`<span class="muted">—</span>`}</td>
        <td>${PLANOS[e.plano]}</td>
        <td class="num">${moeda(e.mensalidade_centavos)}</td>
        <td>${status(e.status)}</td>
        <td><div class="alerta-linha">
          ${e.lancamentos_vencidos ? html`<span class="badge danger">${numero(e.lancamentos_vencidos)} vencido(s)</span>` : ''}
          ${e.extrato_pendente ? html`<span class="badge warn">${numero(e.extrato_pendente)} a conciliar</span>` : ''}
          ${e.tarefas_atrasadas ? html`<span class="badge danger">${numero(e.tarefas_atrasadas)} tarefa(s) atrasada(s)</span>` : ''}
          ${!e.lancamentos_vencidos && !e.extrato_pendente && !e.tarefas_atrasadas ? html`<span class="badge ok">Em dia</span>` : ''}
        </div></td></tr>`) : html`<tr><td colspan="6" class="vazio">Nenhuma empresa encontrada.</td></tr>`}
      </tbody></table>`);
    linksLinhas(alvo);
  };
  $('#busca', alvo).addEventListener('input', debounce((e) => { filtros.busca = e.target.value; carregar(); }));
  $('#status', alvo).addEventListener('change', (e) => { filtros.status = e.target.value; carregar(); });
  $('#nova', alvo)?.addEventListener('click', novaEmpresa);
  await carregar();
}

/** Contrato e dados cadastrais da empresa em atendimento. */
export async function contrato({ alvo, ativo, empresa }) {
  const [equipe, tarefas] = await Promise.all([api.get('/usuarios/equipe'), api.get('/tarefas', { empresa_id: empresa.id, status: 'todas' })]);
  if (!ativo()) return;
  const e = empresa;
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>${e.nome_fantasia || e.razao_social}</h1><p class="muted">${e.razao_social} · CNPJ ${documento(e.cnpj)}</p></div>
      ${gestor() ? html`<button class="btn primario" id="editar">Editar contrato</button>` : ''}</div>
    <div class="grid grid-2-1">
      <div class="card"><div class="card-head"><h2>Contrato</h2>${status(e.status)}</div><div class="card-body">
        <dl class="dl">
          <div><dt>Analista</dt><dd>${e.analista_nome ?? '—'}</dd></div>
          <div><dt>Plano</dt><dd>${PLANOS[e.plano]}</dd></div>
          <div><dt>Mensalidade</dt><dd class="num">${moeda(e.mensalidade_centavos)} · dia ${e.dia_vencimento}</dd></div>
          <div><dt>Vigência</dt><dd>${data(e.inicio_contrato)} a ${e.fim_contrato ? data(e.fim_contrato) : 'indeterminado'}</dd></div>
          <div><dt>Responsável</dt><dd>${e.responsavel ?? '—'}</dd></div>
          <div><dt>E-mail</dt><dd>${e.email ?? '—'}</dd></div>
          <div><dt>Telefone</dt><dd>${telefone(e.telefone)}</dd></div>
        </dl>
        ${e.observacoes ? html`<h3 style="margin:18px 0 6px">Escopo e observações</h3><p style="white-space:pre-wrap;margin:0">${e.observacoes}</p>` : ''}
      </div></div>
      <div class="card"><div class="card-head"><h2>Rotinas e tarefas</h2><a class="small" href="#/tarefas">Abrir tarefas →</a></div>
        <div class="table-wrap"><table><tbody>
          ${tarefas.length ? tarefas.slice(0, 12).map((t) => html`<tr><td>${t.titulo}<div class="small muted">${t.recorrencia !== 'nenhuma' ? `Recorrente (${t.recorrencia}) · ` : ''}${t.responsavel_nome ?? 'Sem responsável'}</div></td>
            <td class="right">${t.status === 'aberta' ? html`<span class="small">${data(t.vencimento)}</span>` : status(t.status)}</td></tr>`)
            : html`<tr><td class="vazio">Nenhuma tarefa.</td></tr>`}
        </tbody></table></div></div>
    </div>`);
  $('#editar', alvo)?.addEventListener('click', () => modal({
    titulo: 'Editar contrato',
    grande: true,
    corpo: formEmpresa(e, equipe),
    aoEnviar: async (form, fechar) => {
      await api.patch(`/empresas/${e.id}`, corpoEmpresa(form));
      fechar();
      toast('Contrato atualizado.');
      window.dispatchEvent(new Event('bpo:empresas'));
      window.dispatchEvent(new Event('bpo:recarregar'));
    },
  }));
}
