import { api } from '../api.js';
import { usuarioAtual } from '../contexto.js';
import { html, $, $$, dataHora, modal, toast, dadosForm, iniciais } from '../ui.js';

const PERFIS = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador', ouvidoria: 'Ouvidoria', antifraude: 'Antifraude' };
const DESCR = {
  admin: 'Acesso total, incluindo usuários e alçadas.',
  gerente: 'Concede limites e empréstimos, pede bloqueios e encerramentos, estorna e emite relatórios, conforme a alçada.',
  operador: 'Cadastra clientes, contas, chaves PIX e favorecidos e libera o Internet Banking, conforme a alçada.',
  ouvidoria: 'Analisa e decide encerramentos, bloqueios e outras solicitações sensíveis.',
  antifraude: 'Monitora transações fora do padrão e tentativas de acesso; analisa e trata alertas de fraude.',
};

function formUsuario(u, aoSalvar) {
  const editando = Boolean(u);
  modal({
    titulo: editando ? `Editar ${u.nome}` : 'Novo usuário',
    corpo: html`<div class="form">
      <div class="c12"><label>Nome</label><input name="nome" required value="${u?.nome ?? ''}"></div>
      <div class="c12"><label>E-mail</label><input name="email" type="email" required value="${u?.email ?? ''}" ${editando ? 'readonly' : ''}></div>
      <div class="c6"><label>Perfil</label><select name="perfil">${Object.entries(PERFIS).map(([k, v]) => html`<option value="${k}" ${u?.perfil === k ? 'selected' : ''}>${v}</option>`)}</select></div>
      ${editando ? html`<div class="c6"><label>Situação</label><select name="ativo"><option value="1" ${u.ativo ? 'selected' : ''}>Ativo</option><option value="0" ${u.ativo ? '' : 'selected'}>Inativo</option></select></div>` : ''}
      <div class="c12"><label>${editando ? 'Redefinir senha (opcional)' : 'Senha inicial'}</label><input name="senha" type="password" minlength="8" autocomplete="new-password" ${editando ? '' : 'required'}>
        <div class="ajuda">Mínimo de 8 caracteres.</div></div>
      <div class="c12 ajuda" id="descr"></div></div>`,
    aoAbrir: (el) => {
      const sel = $('[name=perfil]', el);
      const upd = () => { $('#descr', el).textContent = DESCR[sel.value]; };
      sel.addEventListener('change', upd); upd();
    },
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      if (editando) {
        await api.put(`/usuarios/${u.id}`, { nome: d.nome, perfil: d.perfil, ativo: d.ativo === '1', senha: d.senha || undefined });
      } else {
        await api.post('/usuarios', d);
      }
      fechar(); toast(editando ? 'Usuário atualizado.' : 'Usuário criado.'); aoSalvar();
    },
  });
}

export default async function usuarios({ alvo, ativo }) {
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Usuários</h1><p class="muted">Colaboradores com acesso ao Banqueiro e seus perfis de permissão.</p></div>
      <button class="btn primario" id="novo">+ Novo usuário</button></div>
    <div class="grid perfis-grade" style="margin-bottom:16px">${Object.entries(PERFIS).map(([k, v]) => html`<div class="card card-body"><h3>${v}</h3><p class="muted small" style="margin:4px 0 0">${DESCR[k]}</p></div>`)}</div>
    <div class="card" id="tabela"></div>`);
  async function carregar() {
    const lista = await api.get('/usuarios');
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>Usuário</th><th>Perfil</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead><tbody>
      ${lista.map((u) => html`<tr><td><div class="row" style="flex-wrap:nowrap"><span class="avatar" style="width:30px;height:30px;font-size:11px">${iniciais(u.nome)}</span>
        <div><strong>${u.nome}</strong> ${u.id === usuarioAtual().id ? html`<span class="badge info">você</span>` : ''}<div class="small muted">${u.email}</div></div></div></td>
        <td>${PERFIS[u.perfil]}</td><td>${u.ativo ? html`<span class="badge ok">Ativo</span>` : html`<span class="badge">Inativo</span>`}</td>
        <td class="small">${dataHora(u.ultimo_acesso)}</td><td class="right"><button class="btn sm" data-id="${u.id}">Editar</button></td></tr>`)}
      </tbody></table></div>`);
    $$('[data-id]', alvo).forEach((b) => b.addEventListener('click', () => formUsuario(lista.find((u) => String(u.id) === b.dataset.id), carregar)));
  }
  $('#novo', alvo).onclick = () => formUsuario(null, carregar);
  await carregar();
}
