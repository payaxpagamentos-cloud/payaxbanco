import { api, enderecos } from '../api.js';
import { html, $, $$, moeda, dataHora, confirmar, numero, data, documento, telefone, status, modal, dadosForm, toast, centavos, valorMoedaInput, opcoes, linksLinhas, debounce, hoje } from '../ui.js';
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
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Responsáveis na empresa</h2>
      ${gestor() ? html`<button class="btn sm primario" id="novo-resp">+ Responsável</button>` : ''}</div><div class="table-wrap" id="responsaveis"></div>
      <div class="card-body small muted" style="border-top:1px solid var(--border)">Com acesso ao Portal, o responsável consulta relatórios, envia documentos, conversa com a equipe e, se tiver permissão, aprova pagamentos dentro do limite.</div></div>`);
  await responsaveis(alvo, `/empresas/${e.id}`);
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

const limiteTexto = (c) => (c === -1 ? 'sem limite' : `até ${moeda(c)}`);

/** Responsáveis na empresa cliente, com acesso ao Portal e alçada de aprovação. */
async function responsaveis(alvo, base) {
  const lista = await api.get(`${base}/responsaveis`);
  $('#responsaveis', alvo).innerHTML = String(html`<table><tbody>${lista.length ? lista.map((r) => html`<tr>
    <td><strong>${r.nome}</strong>${r.ativo ? '' : html` <span class="badge">Inativo</span>`}<div class="small muted">${[r.cargo, r.email, r.telefone && telefone(r.telefone)].filter(Boolean).join(' · ')}</div></td>
    <td>${r.acesso_portal ? html`<span class="badge info">Portal</span> ${r.pode_aprovar ? html`<span class="badge ok">Aprova ${limiteTexto(r.limite_aprovacao_centavos)}</span>` : ''}
      ${r.totp_ativo ? html`<span class="badge ok">2 etapas</span>` : ''}<div class="small muted">${r.precisa_trocar_senha ? 'Ainda não fez o primeiro acesso' : r.ultimo_acesso ? `Último acesso ${dataHora(r.ultimo_acesso)}` : ''}</div>`
      : html`<span class="small muted">Sem acesso ao Portal</span>`}${r.recebe_relatorios ? html`<div class="small muted">Recebe relatórios</div>` : ''}</td>
    <td class="right" style="white-space:nowrap">${gestor() ? html`${r.acesso_portal ? html`<button class="btn sm" data-senha="${r.id}">Nova senha</button> ` : ''}
      ${r.totp_ativo ? html`<button class="btn sm" data-reset2fa="${r.id}">Redefinir 2 etapas</button> ` : ''}<button class="btn sm" data-editar-resp="${r.id}">Editar</button>` : ''}</td></tr>`)
    : html`<tr><td class="vazio">Nenhum responsável cadastrado.</td></tr>`}</tbody></table>`);

  const portal = new URL((await enderecos()).portal, location.origin).href;
  const mostrarSenha = (senha, nome) => modal({ titulo: 'Senha provisória do Portal',
    corpo: html`<p style="margin-top:0">Entregue a ${nome} por um canal seguro. Ela aparece só agora e precisa ser trocada no primeiro acesso.</p>
      <div class="card card-body mono" style="font-size:22px;text-align:center;letter-spacing:.1em;box-shadow:none">${senha}</div>
      <p class="small muted">Endereço do Portal: <strong>${portal}</strong></p>` });
  const form = (r = {}) => html`<div class="form">
    <div class="c6"><label>Nome</label><input name="nome" required value="${r.nome ?? ''}"></div>
    <div class="c6"><label>Cargo</label><input name="cargo" value="${r.cargo ?? ''}" placeholder="Sócio, gerente financeiro…"></div>
    <div class="c6"><label>E-mail</label><input name="email" type="email" value="${r.email ?? ''}"></div>
    <div class="c6"><label>Telefone</label><input name="telefone" value="${r.telefone ? telefone(r.telefone) : ''}"></div>
    <div class="c12 stack" style="gap:8px">
      <label class="linha-check"><input type="checkbox" name="recebe_relatorios" ${r.recebe_relatorios ?? 1 ? 'checked' : ''}> Recebe os relatórios do fechamento</label>
      <label class="linha-check"><input type="checkbox" name="acesso_portal" id="acesso" ${r.acesso_portal ? 'checked' : ''}> Acessa o Portal do Cliente</label>
      <label class="linha-check"><input type="checkbox" name="pode_aprovar" id="aprova" ${r.pode_aprovar ? 'checked' : ''}> Aprova pagamentos no Portal</label></div>
    <div class="c6" id="campo-limite"><label>Limite por pagamento (R$)</label><input name="limite" class="moeda" inputmode="numeric" value="${valorMoedaInput(r.limite_aprovacao_centavos > 0 ? r.limite_aprovacao_centavos : 0)}">
      <div class="ajuda">Zero = sem limite.</div></div>
    ${r.id ? html`<div class="c6"><label>Situação</label><select name="ativo"><option value="1">Ativo</option><option value="0" ${r.ativo ? '' : 'selected'}>Inativo</option></select></div>` : ''}</div>`;
  const corpo = (f) => {
    const d = dadosForm(f);
    const limite = centavos(d.limite);
    return { nome: d.nome, cargo: d.cargo, email: d.email, telefone: d.telefone, recebe_relatorios: Boolean(d.recebe_relatorios), acesso_portal: Boolean(d.acesso_portal),
      pode_aprovar: Boolean(d.pode_aprovar), limite_aprovacao_centavos: limite > 0 ? limite : -1, ativo: d.ativo === undefined ? true : d.ativo === '1' };
  };
  const recarregar = () => responsaveis(alvo, base);
  $('#novo-resp', alvo)?.replaceWith($('#novo-resp', alvo).cloneNode(true));
  $('#novo-resp', alvo)?.addEventListener('click', () => modal({ titulo: 'Novo responsável', corpo: form(),
    aoEnviar: async (f, fechar) => { const r = await api.post(`${base}/responsaveis`, corpo(f)); fechar(); recarregar(); if (r.senha_provisoria) mostrarSenha(r.senha_provisoria, dadosForm(f).nome); } }));
  $$('[data-editar-resp]', alvo).forEach((b) => b.addEventListener('click', () => {
    const r = lista.find((x) => x.id === Number(b.dataset.editarResp));
    modal({ titulo: `Editar ${r.nome}`, corpo: form(r),
      aoEnviar: async (f, fechar) => { const x = await api.patch(`${base}/responsaveis/${r.id}`, corpo(f)); fechar(); recarregar(); if (x.senha_provisoria) mostrarSenha(x.senha_provisoria, r.nome); } });
  }));
  $$('[data-senha]', alvo).forEach((b) => b.addEventListener('click', async () => {
    const r = lista.find((x) => x.id === Number(b.dataset.senha));
    if (!(await confirmar('Gerar nova senha', `A senha atual de ${r.nome} deixa de valer.`, 'Gerar'))) return;
    try { const x = await api.post(`${base}/responsaveis/${r.id}/nova-senha`); mostrarSenha(x.senha_provisoria, r.nome); recarregar(); } catch (err) { toast(err.message, 'erro'); }
  }));
  $$('[data-reset2fa]', alvo).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmar('Redefinir verificação em duas etapas', 'Use quando o responsável perdeu o celular.', 'Redefinir'))) return;
    try { await api.post(`${base}/responsaveis/${b.dataset.reset2fa}/reset-2fa`); toast('Verificação redefinida.'); recarregar(); } catch (err) { toast(err.message, 'erro'); }
  }));
}
