import { api, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, paginacao, campo, lerForm, modal, toast, acao, selo,
  dataHora, data, hojeIso, somarDias, R, icone
} from '../../comum/ui.js';

/** Usuários da equipe e registro de auditoria. */
export default async function admin({ alvo, query, recarregar, ir }) {
  const aba = query.aba ?? (pode('*') ? 'usuarios' : 'auditoria');
  montar(alvo, 
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Usuários e auditoria'),
      el('p', {}, 'Quem acessa o backoffice e o que foi feito no sistema.'))),
    el('div', { class: 'abas' },
      pode('*') ? el('button', { class: aba === 'usuarios' ? 'ativa' : '', onclick: () => ir('#/admin?aba=usuarios') }, 'Usuários') : null,
      el('button', { class: aba === 'auditoria' ? 'ativa' : '', onclick: () => ir('#/admin?aba=auditoria') }, 'Auditoria')),
    el('div', { id: 'corpo' }));
  const corpo = alvo.querySelector('#corpo');
  if (aba === 'usuarios' && pode('*')) await telaUsuarios(corpo, recarregar);
  else await telaAuditoria(corpo, query, ir);
}

async function telaUsuarios(alvo, recarregar) {
  const itens = await api.get('/admin/usuarios');
  montar(alvo, cartao(null, tabela({
    colunas: [
      { titulo: 'Nome', conteudo: (u) => el('span', {}, el('span', { class: 'forte' }, u.nome), el('span', { class: 'sub' }, u.email)) },
      { titulo: 'Perfil', conteudo: (u) => R.perfilEquipe[u.perfil] ?? u.perfil },
      { titulo: 'Último acesso', conteudo: (u) => (u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca entrou') },
      { titulo: 'Situação', conteudo: (u) => selo(u.ativo ? 'ativo' : 'suspenso', { ativo: ['Ativo', 'ok'], suspenso: ['Inativo', 'neutra'] }) },
      { titulo: '', dir: true, conteudo: (u) => el('button', { class: 'botao sutil pequeno', onclick: (e) => { e.stopPropagation(); editarUsuario(u, recarregar); } }, 'Editar') },
    ],
    itens,
    vazio: 'Nenhum usuário.',
  }), el('button', { class: 'botao', onclick: () => editarUsuario(null, recarregar) }, icone('mais'), 'Novo usuário')));
}

function editarUsuario(u, recarregar) {
  const novo = !u;
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'nome', rotulo: 'Nome', valor: u?.nome ?? '', obrigatorio: true }),
    novo ? campo({ nome: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true }) : null,
    campo({ nome: 'perfil', rotulo: 'Perfil', tipo: 'select', valor: u?.perfil ?? 'operacao', opcoes: Object.entries(R.perfilEquipe) }),
    campo({ nome: 'senha', rotulo: novo ? 'Senha inicial (mín. 8)' : 'Nova senha (opcional)', tipo: 'password', obrigatorio: novo }),
    novo ? null : campo({ nome: 'ativo', rotulo: 'Situação', tipo: 'select', valor: String(u.ativo), opcoes: [['1', 'Ativo'], ['0', 'Inativo']] }));
  const botao = el('button', { class: 'botao' }, novo ? 'Criar usuário' : 'Salvar');
  botao.addEventListener('click', () => acao(botao, async () => {
    const d = lerForm(form);
    if (!novo && !d.senha) delete d.senha;
    if (novo) await api.post('/admin/usuarios', d);
    else await api.patch(`/admin/usuarios/${u.id}`, d);
    m.fechar();
    toast(novo ? 'Usuário criado.' : 'Usuário atualizado.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: novo ? 'Novo usuário' : `Editar ${u.nome}`, corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

async function telaAuditoria(alvo, query, ir) {
  const f = { de: query.de ?? somarDias(hojeIso(), -7), ate: query.ate ?? hojeIso(), acao: query.acao ?? '', pagina: Number(query.pagina) || 1 };
  const d = await api.get(`/admin/auditoria${qs(f)}`);
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/admin${qs({ aba: 'auditoria', ...f, ...lerForm(form), pagina: 1 })}`); } },
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: f.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: f.ate }),
    campo({ nome: 'acao', rotulo: 'Ação começa com', valor: f.acao, atributos: { placeholder: 'boleto. · repasse. · cliente.' } }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'));
  montar(alvo, form, tabela({
    colunas: [
      { titulo: 'Quando', conteudo: (a) => dataHora(a.criado_em) },
      { titulo: 'Quem', conteudo: (a) => el('span', {}, a.usuario_nome ?? 'sistema', el('span', { class: 'sub' }, a.usuario_tipo)) },
      { titulo: 'Ação', conteudo: (a) => a.acao },
      { titulo: 'Registro', conteudo: (a) => el('span', {}, [a.entidade, a.entidade_id].filter(Boolean).join(' #'),
        a.razao_social ? el('span', { class: 'sub' }, a.razao_social) : null) },
      { titulo: 'IP', conteudo: (a) => a.ip ?? '—' },
    ],
    itens: d.itens,
    vazio: 'Nenhum registro no período.',
    aoClicar: (a) => modal({ titulo: `${a.acao} · ${dataHora(a.criado_em)}`, largo: true, corpo: el('div', { style: 'display:grid;gap:10px' },
      a.antes ? el('div', {}, el('strong', {}, 'Antes'), el('div', { class: 'codigo' }, a.antes)) : null,
      a.depois ? el('div', {}, el('strong', {}, 'Depois'), el('div', { class: 'codigo' }, a.depois)) : null,
      el('div', { class: 'sub' }, `request_id: ${a.request_id ?? '—'}`)) }),
    rodape: paginacao(d, (p) => ir(`#/admin${qs({ aba: 'auditoria', ...f, pagina: p })}`)),
  }));
}
