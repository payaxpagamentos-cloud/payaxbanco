import { api } from '../api.js';
import { html, $$, dataHora, numero, modal, dadosForm, toast, opcoes, moeda, centavos, valorMoedaInput } from '../ui.js';

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
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Nome</th><th>Perfil</th><th class="num">Empresas</th><th>Aprova pagamentos</th><th>Último acesso</th><th>Situação</th><th></th></tr></thead><tbody>
      ${lista.map((u) => html`<tr><td><strong>${u.nome}</strong><div class="small muted">${u.email}</div></td><td>${ROTULO[u.perfil]}</td>
        <td class="num">${numero(u.empresas)}</td>
        <td class="small">${u.alcada_efetiva_centavos === -1 ? 'Sem limite' : u.alcada_efetiva_centavos === 0 ? html`<span class="muted">Não</span>` : `Até ${moeda(u.alcada_efetiva_centavos)}`}${u.alcada_aprovacao_centavos === null ? html`<div class="muted">padrão do perfil</div>` : ''}</td>
        <td>${dataHora(u.ultimo_acesso)}${u.totp_ativo ? html`<div class="small pos">2 etapas</div>` : ''}</td>
        <td>${u.ativo ? html`<span class="badge ok">Ativo</span>` : html`<span class="badge">Inativo</span>`}</td>
        <td class="right"><button class="btn sm" data-editar="${u.id}">Editar</button></td></tr>`)}
    </tbody></table></div></div>`);
  const form = (u = {}) => html`<div class="form">
    <div class="c12"><label>Nome</label><input name="nome" required value="${u.nome ?? ''}"></div>
    ${u.id ? '' : html`<div class="c12"><label>E-mail</label><input name="email" type="email" required></div>`}
    <div class="c12"><label>Perfil</label><select name="perfil">${opcoes(PERFIS, { selecionado: u.perfil ?? 'analista' })}</select></div>
    <div class="c6"><label>${u.id ? 'Nova senha (opcional)' : 'Senha inicial'}</label><input name="senha" type="password" minlength="8" autocomplete="new-password" ${u.id ? '' : 'required'}></div>
    ${u.id ? html`<div class="c6"><label>Aprovação de pagamentos</label><select name="alcada_modo">
        <option value="padrao" ${u.alcada_aprovacao_centavos === null ? 'selected' : ''}>Padrão do perfil</option>
        <option value="nao" ${u.alcada_aprovacao_centavos === 0 ? 'selected' : ''}>Não aprova</option>
        <option value="limite" ${u.alcada_aprovacao_centavos > 0 ? 'selected' : ''}>Até um valor</option>
        <option value="livre" ${u.alcada_aprovacao_centavos === -1 ? 'selected' : ''}>Sem limite</option></select></div>
      <div class="c6"><label>Valor da alçada (R$)</label><input name="alcada_valor" class="moeda" inputmode="numeric" value="${valorMoedaInput(u.alcada_aprovacao_centavos > 0 ? u.alcada_aprovacao_centavos : 0)}">
        <div class="ajuda">Usado com "Até um valor". Padrão: administrador e supervisor sem limite; analista não aprova.</div></div>` : ''}
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
        const alcada = { padrao: null, nao: 0, livre: -1, limite: centavos(d.alcada_valor) }[d.alcada_modo];
        if (d.alcada_modo === 'limite' && !alcada) throw new Error('Informe o valor da alçada.');
        await api.patch(`/usuarios/${u.id}`, { nome: d.nome, perfil: d.perfil, ativo: d.ativo === '1', senha: d.senha || undefined, alcada_aprovacao_centavos: alcada });
        fechar(); toast('Usuário atualizado.'); window.dispatchEvent(new Event('bpo:recarregar'));
      },
    });
  }));
}
