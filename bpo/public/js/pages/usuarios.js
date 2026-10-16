import { api } from '../api.js';
import { html, $$, dataHora, numero, modal, dadosForm, toast, opcoes } from '../ui.js';

const PERFIS = [
  { id: 'analista', nome: 'Analista — trabalha só nas empresas da própria carteira' },
  { id: 'supervisor', nome: 'Supervisor — vê todas as empresas e gerencia contratos' },
  { id: 'admin', nome: 'Administrador — tudo, inclusive usuários' },
];
const ROTULO = { analista: 'Analista', supervisor: 'Supervisor', admin: 'Administrador' };

export default async function usuarios({ alvo, ativo }) {
  const lista = await api.get('/usuarios');
  if (!ativo()) return;
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Usuários da equipe</h1><p class="muted">Quem acessa o BPO Financeiro.</p></div>
      <button class="btn primario" id="novo">+ Novo usuário</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Nome</th><th>Perfil</th><th class="num">Empresas</th><th>Último acesso</th><th>Situação</th><th></th></tr></thead><tbody>
      ${lista.map((u) => html`<tr><td><strong>${u.nome}</strong><div class="small muted">${u.email}</div></td><td>${ROTULO[u.perfil]}</td>
        <td class="num">${numero(u.empresas)}</td><td>${dataHora(u.ultimo_acesso)}</td>
        <td>${u.ativo ? html`<span class="badge ok">Ativo</span>` : html`<span class="badge">Inativo</span>`}</td>
        <td class="right"><button class="btn sm" data-editar="${u.id}">Editar</button></td></tr>`)}
    </tbody></table></div></div>`);
  const form = (u = {}) => html`<div class="form">
    <div class="c12"><label>Nome</label><input name="nome" required value="${u.nome ?? ''}"></div>
    ${u.id ? '' : html`<div class="c12"><label>E-mail</label><input name="email" type="email" required></div>`}
    <div class="c12"><label>Perfil</label><select name="perfil">${opcoes(PERFIS, { selecionado: u.perfil ?? 'analista' })}</select></div>
    <div class="c6"><label>${u.id ? 'Nova senha (opcional)' : 'Senha inicial'}</label><input name="senha" type="password" minlength="8" autocomplete="new-password" ${u.id ? '' : 'required'}></div>
    ${u.id ? html`<div class="c6"><label>Situação</label><select name="ativo"><option value="1" ${u.ativo ? 'selected' : ''}>Ativo</option><option value="0" ${u.ativo ? '' : 'selected'}>Inativo</option></select></div>` : ''}
  </div>`;
  $$('#novo', alvo).forEach((b) => b.addEventListener('click', () => modal({
    titulo: 'Novo usuário', corpo: form(),
    aoEnviar: async (f, fechar) => { await api.post('/usuarios', dadosForm(f)); fechar(); toast('Usuário criado.'); window.dispatchEvent(new Event('bpo:recarregar')); },
  })));
  $$('[data-editar]', alvo).forEach((b) => b.addEventListener('click', () => {
    const u = lista.find((x) => x.id === Number(b.dataset.editar));
    modal({
      titulo: `Editar ${u.nome}`, corpo: form(u),
      aoEnviar: async (f, fechar) => {
        const d = dadosForm(f);
        await api.patch(`/usuarios/${u.id}`, { nome: d.nome, perfil: d.perfil, ativo: d.ativo === '1', senha: d.senha || undefined });
        fechar(); toast('Usuário atualizado.'); window.dispatchEvent(new Event('bpo:recarregar'));
      },
    });
  }));
}
