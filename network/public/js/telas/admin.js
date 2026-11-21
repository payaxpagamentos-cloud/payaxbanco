import { api, qs } from '../api.js';
import { el, limpar, cabecalho, painel, tabela, paginacao, abas, etq, dataHora, dl, toast, carregar, formulario, botao, dinheiro, usuario } from '../ui.js';

export default async function admin({ alvo }) {
  const lista = [['usuarios', 'Usuários e perfis'], ['permissoes', 'Permissões'], ['organizacao', 'Organização'], ['financeiro', 'Faturamento e cobrança'], ['auditoria', 'Auditoria']];
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
    /*
     * Parâmetros que o motor de faturamento e a régua de cobrança leem a cada execução. A carência é a garantia
     * da operação: nenhuma regra da régua bloqueia antes dela, mesmo pedindo um corte mais cedo.
     */
    financeiro: () => carregar(corpo, async () => (org = await api.get('/organizacao')), (o) => painel('Faturamento e cobrança', el('div', {},
      dl([
        ['Dia de vencimento padrão', `dia ${o.dia_vencimento_padrao} (cada contrato pode ter o seu)`],
        ['Carência antes de qualquer bloqueio', `${o.carencia_bloqueio_dias} dia(s) após o vencimento`],
        ['Multa por atraso', `${(o.multa_atraso_pct_centesimos / 100).toLocaleString('pt-BR')}% uma única vez sobre o saldo`],
        ['Juros', `${(o.juros_mes_pct_centesimos / 100).toLocaleString('pt-BR')}% ao mês, proporcional aos dias`],
        ['Primeira fatura proporcional', o.pro_rata ? 'Sim: o mês de entrada (e o de saída) é cobrado pelos dias de serviço' : 'Não: o mês de entrada é cobrado inteiro'],
        ['Desbloqueio de confiança', o.confianca_dias ? `até ${o.confianca_dias} dia(s), no máximo ${o.confianca_max_ano} vez(es) por ano em cada contrato` : 'Desligado'],
      ]),
      botao('Editar', () => formulario('Faturamento e cobrança', [
        { nome: 'dia_vencimento_padrao', rotulo: 'Dia de vencimento padrão', tipo: 'number', min: 1, max: 28, valor: o.dia_vencimento_padrao,
          ajuda: 'De 1 a 28, para existir em todo mês. Vale para contratos novos.' },
        { nome: 'carencia_bloqueio_dias', rotulo: 'Carência antes do bloqueio (dias)', tipo: 'number', valor: o.carencia_bloqueio_dias,
          ajuda: 'Nenhuma regra da régua corta antes disso, mesmo configurada para menos.' },
        { nome: 'multa_atraso_pct', rotulo: 'Multa por atraso (%)', tipo: 'decimal', valor: (o.multa_atraso_pct_centesimos / 100).toString().replace('.', ','), ajuda: 'Cobrada uma vez sobre o saldo.' },
        { nome: 'juros_mes_pct', rotulo: 'Juros ao mês (%)', tipo: 'decimal', valor: (o.juros_mes_pct_centesimos / 100).toString().replace('.', ','), ajuda: 'Proporcional aos dias de atraso.' },
        { nome: 'pro_rata', rotulo: 'Cobrar o mês de entrada e de saída pelos dias de serviço', tipo: 'checkbox', valor: Boolean(o.pro_rata), inteiro: true },
        { nome: 'confianca_dias', rotulo: 'Desbloqueio de confiança: prazo máximo (dias)', tipo: 'number', valor: o.confianca_dias, ajuda: 'Zero desliga o recurso.' },
        { nome: 'confianca_max_ano', rotulo: 'Confianças por contrato por ano', tipo: 'number', valor: o.confianca_max_ano, ajuda: 'Zero não limita.' },
      ], { largo: true, enviar: async (d) => { await api.patch('/organizacao', d); toast('Parâmetros salvos. Valem na próxima execução do ciclo e da régua.'); TELAS.financeiro(); } }),
      { tipo: 'secundario' })))),
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
