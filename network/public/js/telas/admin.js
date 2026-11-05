import { api, qs } from '../api.js';
import { el, limpar, cabecalho, painel, tabela, paginacao, abas, etq, dataHora, toast, carregar, formulario, botao, dinheiro, usuario } from '../ui.js';

export default async function admin({ alvo }) {
  const lista = [['usuarios', 'Usuários e perfis'], ['permissoes', 'Permissões'], ['organizacao', 'Organização'], ['auditoria', 'Auditoria']];
  let aba = 'usuarios';
  const corpo = el('div');
  const barra = el('div');
  const trocar = (id) => { aba = id; barra.replaceChildren(abas(lista, aba, trocar)); TELAS[aba](); };
  limpar(alvo, cabecalho({ sobretitulo: 'Sistema', titulo: 'Organização e acessos', descricao: 'Usuários, perfis e o histórico de auditoria. As permissões são verificadas no servidor em cada operação.' }), barra, corpo);
  let org = null;
  const TELAS = {
    usuarios: () => carregar(corpo, async () => { org ??= await api.get('/organizacao'); return api.get('/organizacao/usuarios'); }, (l) => painel(null, tabela([
      { titulo: 'Nome', valor: (u) => el('div', {}, el('div', { class: 'forte' }, u.nome), el('div', { class: 'fraco' }, u.email)) },
      { titulo: 'Perfil', valor: (u) => org.perfis[u.perfil] }, { titulo: 'Último acesso', valor: (u) => dataHora(u.ultimo_acesso) },
      { titulo: 'Situação', valor: (u) => (u.ativo ? etq('Ativo', 'ok') : etq('Desativado', 'neutra')) },
    ], l, { aoClicar: (u) => editarUsuario(u, org, () => TELAS.usuarios()) }), { semCorpo: true, acoes: [botao('Novo usuário', () => editarUsuario(null, org, () => TELAS.usuarios()), { ic: 'mais', tipo: 'pequeno' })] })),
    permissoes: () => carregar(corpo, async () => (org ??= await api.get('/organizacao')), (o) => {
      const perfis = Object.keys(o.perfis);
      return painel('Matriz de permissões', el('div', { class: 'tabela-rolagem' }, el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Permissão'), perfis.map((p) => el('th', {}, o.perfis[p])))),
        el('tbody', {}, Object.entries(o.matriz).map(([perm, quem]) => el('tr', {}, el('td', {}, perm), perfis.map((p) => el('td', {}, quem.includes(p) ? '●' : ''))))))),
      { rodape: [el('span', {}, 'Técnico: só os próprios chamados, comissões e abastecimentos. Ninguém aprova a própria comissão. Consulta/TV não escreve.')] });
    }),
    organizacao: () => carregar(corpo, async () => (org = await api.get('/organizacao')), (o) => painel('Parâmetros da operação', el('div', {},
      el('p', { class: 'fraco', style: 'margin-bottom:12px' }, `Fuso ${o.fuso} · aprovação de manutenção acima de ${dinheiro(o.aprovacao_manutencao_centavos)} só pelo administrador · recorrência ${o.janela_recorrencia_min} min · desatualizado após ${o.desatualizado_min} min · reserva de porta ${o.reserva_porta_horas} h.`),
      botao('Editar parâmetros', () => formulario('Parâmetros da operação', [
        { nome: 'nome', rotulo: 'Nome da organização', valor: o.nome, obrigatorio: true, inteiro: true },
        { nome: 'fuso', rotulo: 'Fuso da operação', tipo: 'select', vazio: false, valor: o.fuso, opcoes: o.fusos.map((f) => [f, f]) },
        { nome: 'aprovacao_manutencao', rotulo: 'Manutenção: alçada do gestor de frota (R$)', tipo: 'decimal', valor: (o.aprovacao_manutencao_centavos / 100).toFixed(2).replace('.', ',') },
        { nome: 'janela_recorrencia_min', rotulo: 'Janela de recorrência de incidente (min)', tipo: 'number', valor: o.janela_recorrencia_min },
        { nome: 'desatualizado_min', rotulo: 'Leitura desatualizada após (min)', tipo: 'number', valor: o.desatualizado_min },
        { nome: 'reserva_porta_horas', rotulo: 'Validade da reserva de porta (h)', tipo: 'number', valor: o.reserva_porta_horas },
      ], { enviar: async (d) => { await api.patch('/organizacao', d); toast('Parâmetros salvos.'); TELAS.organizacao(); } }), { tipo: 'secundario' })))),
    auditoria: (f = { pagina: 1 }) => carregar(corpo, () => api.get(`/organizacao/auditoria${qs(f)}`), (l) => painel(null, tabela([
      { titulo: 'Quando', valor: (a) => dataHora(a.criado_em, { segundos: true }) }, { titulo: 'Quem', valor: (a) => a.usuario_nome ?? 'Sistema' },
      { titulo: 'Ação', valor: (a) => a.acao.replaceAll('_', ' ') }, { titulo: 'Recurso', valor: (a) => (a.recurso ? `${a.recurso} #${a.recurso_id ?? ''}` : '—') },
      { titulo: 'Detalhe', valor: (a) => el('span', { class: 'fraco' }, (a.depois ?? '').slice(0, 140)) }, { titulo: 'Request ID', valor: (a) => el('span', { class: 'fraco' }, a.request_id ?? '—') },
    ], l.itens, { pagina: paginacao(l, (p) => TELAS.auditoria({ pagina: p })) }), { semCorpo: true })),
  };
  trocar(aba);
}

function editarUsuario(u, org, depois) {
  return formulario(u ? 'Editar usuário' : 'Novo usuário', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: u?.nome, inteiro: true },
    u ? null : { nome: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true, inteiro: true },
    { nome: 'perfil', rotulo: 'Perfil', tipo: 'select', obrigatorio: true, valor: u?.perfil, opcoes: Object.entries(org.perfis), inteiro: true },
    { nome: 'senha', rotulo: u ? 'Nova senha (vazio mantém)' : 'Senha inicial', tipo: 'password', obrigatorio: !u, inteiro: true, ajuda: 'Pelo menos 8 caracteres.', autocomplete: 'new-password' },
    u && u.id !== usuario().id ? { nome: 'ativo', rotulo: 'Acesso ativo', tipo: 'checkbox', valor: u.ativo } : null,
  ], { enviar: async (d) => {
    if (u) await api.patch(`/organizacao/usuarios/${u.id}`, { ...d, senha: d.senha || undefined });
    else await api.post('/organizacao/usuarios', d);
    toast('Usuário salvo. Para técnicos, vincule o usuário em Equipe e comissões.');
    depois();
  } });
}
