import { api } from '../api.js';
import { html, $, $$, data, status, modal, dadosForm, toast, opcoes, hoje, confirmar } from '../ui.js';
import { usuarioAtual } from '../contexto.js';

const RECORRENCIA = [{ id: 'nenhuma', nome: 'Não se repete' }, { id: 'semanal', nome: 'Toda semana' }, { id: 'mensal', nome: 'Todo mês' }];
const PRAZOS = [['', 'Todos os prazos'], ['atrasadas', 'Atrasadas'], ['hoje', 'Hoje'], ['semana', 'Próximos 7 dias']];

function formTarefa(t, empresas, equipe) {
  return html`<div class="form">
    <div class="c12"><label>Empresa</label><select name="empresa_id" required ${t.id ? 'disabled' : ''}>${opcoes(empresas, { selecionado: t.empresa_id, rotulo: 'rotulo', vazio: 'Selecione' })}</select></div>
    <div class="c12"><label>Título</label><input name="titulo" required value="${t.titulo ?? ''}"></div>
    <div class="c6"><label>Responsável</label><select name="responsavel_id">${opcoes(equipe, { selecionado: t.responsavel_id ?? usuarioAtual().id, vazio: 'Sem responsável' })}</select></div>
    <div class="c3"><label>Prazo</label><input name="vencimento" type="date" required value="${t.vencimento ?? hoje()}"></div>
    <div class="c3"><label>Repetição</label><select name="recorrencia">${opcoes(RECORRENCIA, { selecionado: t.recorrencia ?? 'nenhuma' })}</select></div>
    <div class="c12"><label>Detalhes</label><textarea name="descricao">${t.descricao ?? ''}</textarea></div>
  </div>`;
}

export default async function tarefas({ alvo, ativo }) {
  const [empresas, equipe] = await Promise.all([api.get('/empresas'), api.get('/usuarios/equipe')]);
  if (!ativo()) return;
  const listaEmpresas = empresas.filter((e) => e.status !== 'encerrada').map((e) => ({ id: e.id, rotulo: e.nome_fantasia || e.razao_social }));
  const filtros = { status: 'aberta', prazo: '', empresa_id: '', responsavel_id: '' };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Tarefas e rotinas</h1><p class="muted">Rotinas recorrentes criam a próxima ocorrência quando concluídas.</p></div>
      <button class="btn primario" id="nova">+ Nova tarefa</button></div>
    <div class="card">
      <div class="filtros">
        <select class="campo" data-f="status"><option value="aberta">Abertas</option><option value="concluida">Concluídas</option><option value="cancelada">Canceladas</option><option value="todas">Todas</option></select>
        <select class="campo" data-f="prazo">${PRAZOS.map(([v, r]) => html`<option value="${v}">${r}</option>`)}</select>
        <select class="campo" data-f="empresa_id">${opcoes(listaEmpresas, { rotulo: 'rotulo', vazio: 'Todas as empresas' })}</select>
        <select class="campo" data-f="responsavel_id">${opcoes(equipe, { vazio: 'Todos os responsáveis' })}</select>
      </div>
      <div class="table-wrap" id="tabela"></div>
    </div>`);
  const dia = hoje();
  const carregar = async () => {
    const lista = await api.get('/tarefas', filtros);
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<table><thead><tr><th>Tarefa</th><th>Empresa</th><th>Responsável</th><th>Prazo</th><th></th></tr></thead><tbody>
      ${lista.length ? lista.map((t) => html`<tr>
        <td><strong>${t.titulo}</strong>${t.recorrencia !== 'nenhuma' ? html` <span class="badge">${t.recorrencia === 'mensal' ? 'Mensal' : 'Semanal'}</span>` : ''}
          ${t.descricao ? html`<div class="small muted" style="white-space:pre-wrap">${t.descricao}</div>` : ''}</td>
        <td><a href="#/e/${t.empresa_id}/visao">${t.empresa_nome}</a></td>
        <td>${t.responsavel_nome ?? html`<span class="muted">—</span>`}</td>
        <td>${t.status !== 'aberta' ? html`${status(t.status)}${t.concluida_em ? html`<div class="small muted">${data(t.concluida_em)}${t.concluida_por_nome ? ` · ${t.concluida_por_nome}` : ''}</div>` : ''}`
          : t.vencimento < dia ? html`<span class="badge danger">Atrasada · ${data(t.vencimento)}</span>` : t.vencimento === dia ? html`<span class="badge warn">Hoje</span>` : data(t.vencimento)}</td>
        <td class="right" style="white-space:nowrap">${t.status === 'aberta' ? html`<button class="btn sm primario" data-concluir="${t.id}">Concluir</button>
          <button class="btn sm" data-editar="${t.id}">Editar</button> <button class="btn sm perigo" data-cancelar="${t.id}">Cancelar</button>` : ''}</td></tr>`)
        : html`<tr><td colspan="5" class="vazio">Nenhuma tarefa com esses filtros.</td></tr>`}
      </tbody></table>`);
    $$('[data-concluir]', alvo).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api.post(`/tarefas/${b.dataset.concluir}/concluir`);
        toast(r.vencimento ? `Concluída. Próxima ocorrência em ${data(r.vencimento)}.` : 'Tarefa concluída.');
        carregar();
      } catch (err) { toast(err.message, 'erro'); b.disabled = false; }
    }));
    $$('[data-cancelar]', alvo).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmar('Cancelar tarefa', 'A tarefa sai da lista e, se for recorrente, não gera a próxima ocorrência.', 'Cancelar tarefa'))) return;
      try { await api.post(`/tarefas/${b.dataset.cancelar}/cancelar`); carregar(); } catch (err) { toast(err.message, 'erro'); }
    }));
    $$('[data-editar]', alvo).forEach((b) => b.addEventListener('click', () => {
      const t = lista.find((x) => x.id === Number(b.dataset.editar));
      modal({
        titulo: 'Editar tarefa',
        corpo: formTarefa(t, listaEmpresas, equipe),
        aoEnviar: async (form, fechar) => { await api.patch(`/tarefas/${t.id}`, dadosForm(form)); fechar(); toast('Tarefa atualizada.'); carregar(); },
      });
    }));
  };
  $$('[data-f]', alvo).forEach((s) => s.addEventListener('change', () => { filtros[s.dataset.f] = s.value; carregar(); }));
  $('#nova', alvo).addEventListener('click', () => modal({
    titulo: 'Nova tarefa',
    corpo: formTarefa({}, listaEmpresas, equipe),
    aoEnviar: async (form, fechar) => { await api.post('/tarefas', dadosForm(form)); fechar(); toast('Tarefa criada.'); carregar(); },
  }));
  await carregar();
}
