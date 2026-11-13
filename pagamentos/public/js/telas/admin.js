import { api, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, paginacao, campo, lerForm, modal, confirmar, toast, acao, aviso, selo,
  numero, dataHora, data, hojeIso, somarDias, R, icone,
} from '../../comum/ui.js';

/** Usuários da equipe, segurança (backups e 2FA) e registro de auditoria. */
export default async function admin({ alvo, query, recarregar, ir }) {
  const aba = query.aba ?? (pode('*') ? 'usuarios' : 'seguranca');
  montar(alvo,
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Segurança e usuários'),
      el('p', {}, 'Quem acessa o backoffice, os backups do banco e o que foi feito no sistema.'))),
    el('div', { class: 'abas' },
      pode('*') ? el('button', { class: aba === 'usuarios' ? 'ativa' : '', onclick: () => ir('#/admin?aba=usuarios') }, 'Usuários') : null,
      el('button', { class: aba === 'seguranca' ? 'ativa' : '', onclick: () => ir('#/admin?aba=seguranca') }, 'Segurança e backups'),
      el('button', { class: aba === 'auditoria' ? 'ativa' : '', onclick: () => ir('#/admin?aba=auditoria') }, 'Auditoria')),
    el('div', { id: 'corpo' }));
  const corpo = alvo.querySelector('#corpo');
  if (aba === 'usuarios' && pode('*')) await telaUsuarios(corpo, recarregar);
  else if (aba === 'seguranca') await telaSeguranca(corpo, recarregar);
  else await telaAuditoria(corpo, query, ir);
}

/** Backups do banco e autenticação em duas etapas. */
async function telaSeguranca(alvo, recarregar) {
  const d = await api.get('/seguranca');
  const b = d.backups;
  const tamanho = (n) => `${(n / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;

  montar(alvo,
    !b.ultimo ? aviso('Nenhum backup foi gerado ainda. A conta gráfica é o livro-razão do dinheiro dos clientes — gere o primeiro agora.', 'erro')
      : !b.ultimo.confere ? aviso(`O último backup NÃO conferiu: ${b.ultimo.divergencia}`, 'erro')
        : b.atrasado ? aviso(`O último backup foi há ${b.horas_desde} h. O esperado é a cada ${b.intervalo_horas} h.`, 'aviso')
          : aviso(`Último backup há ${b.horas_desde} h, conferido. Guardando os ${b.manter} mais recentes.`, 'ok'),

    el('div', { style: 'margin-top:14px' }, cartao('Backups do banco',
      el('div', {},
        el('p', { style: 'color:var(--texto-2);font-size:13px;margin-bottom:12px' },
          'Cada cópia é conferida logo depois de gerada: integridade do arquivo e se o total do razão bate com o banco em uso.'),
        tabela({
          colunas: [
            { titulo: 'Arquivo', conteudo: (x) => el('span', {}, el('span', { class: 'forte num' }, x.nome),
              el('span', { class: 'sub' }, `${x.automatico ? 'automático' : `manual · ${x.criado_por_nome ?? '—'}`}`)) },
            { titulo: 'Quando', conteudo: (x) => dataHora(x.criado_em) },
            { titulo: 'Tamanho', dir: true, conteudo: (x) => tamanho(x.tamanho) },
            { titulo: 'Lançamentos', dir: true, conteudo: (x) => numero(x.lancamentos) },
            { titulo: 'Conferência', conteudo: (x) => el('span', {}, selo(x.confere ? 'ok' : 'falhou', { ok: ['Conferido', 'ok'], falhou: ['Não conferiu', 'erro'] }),
              x.divergencia ? el('span', { class: 'sub' }, x.divergencia) : null) },
            { titulo: '', dir: true, conteudo: (x) => (x.disponivel && pode('*')
              ? el('button', { class: 'botao sutil pequeno', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/seguranca/backups/${x.nome}`, x.nome)) }, icone('baixar'), 'Baixar')
              : el('span', { class: 'sub' }, x.disponivel ? '' : 'arquivo removido')) },
          ],
          itens: b.historico,
          vazio: 'Nenhum backup ainda.',
        })),
      pode('*') ? el('button', { class: 'botao', onclick: (e) => acao(e.currentTarget, async () => {
        const out = await api.post('/seguranca/backups', {});
        toast(`Backup ${out.nome} gerado e conferido.`, 'ok');
        recarregar();
      }) }, icone('baixar'), 'Gerar backup agora') : null)),

    el('div', { style: 'margin-top:18px' }, cartao('Autenticação em duas etapas',
      el('div', {},
        el('div', { class: 'pares' },
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Obrigatória para a equipe'),
            el('span', { class: 'val' }, d.exigir_2fa_equipe ? 'Sim' : 'Não')),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Usuários ativos sem 2FA'),
            el('span', { class: 'val' }, numero(d.sem_2fa))),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Logins recusados em 24 h'),
            el('span', { class: 'val' }, numero(d.logins_recusados_24h)))),
        el('p', { style: 'margin-top:10px;color:var(--texto-2);font-size:13px' },
          'Quem aprova e envia repasse movimenta dinheiro de terceiros. Com a exigência ligada, ninguém da equipe trabalha sem configurar.'),
        el('div', { style: 'margin-top:14px' }, tabela({
          colunas: [
            { titulo: 'Pessoa', conteudo: (u) => el('span', {}, el('span', { class: 'forte' }, u.nome), el('span', { class: 'sub' }, u.email)) },
            { titulo: 'Perfil', conteudo: (u) => R.perfilEquipe[u.perfil] ?? u.perfil },
            { titulo: 'Duas etapas', conteudo: (u) => selo(u.totp_ativo ? 'ok' : 'nao', { ok: ['Ativa', 'ok'], nao: ['Sem 2FA', 'aviso'] }) },
            { titulo: 'Último acesso', conteudo: (u) => (u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca entrou') },
            { titulo: '', dir: true, conteudo: (u) => (u.totp_ativo && pode('*')
              ? el('button', { class: 'botao sutil pequeno', onclick: async (e) => {
                const ok = await confirmar({ titulo: 'Redefinir duas etapas', texto: `${u.nome} vai precisar configurar de novo no próximo acesso. Use quando a pessoa trocar de celular.`, confirmarTexto: 'Redefinir', perigo: true });
                if (ok) acao(e.currentTarget, async () => { await api.post(`/seguranca/equipe/${u.id}/redefinir-2fa`, {}); toast('Redefinida.'); recarregar(); });
              } }, 'Redefinir') : null) },
          ],
          itens: d.equipe,
        }))),
      pode('*') ? el('button', { class: d.exigir_2fa_equipe ? 'botao sec' : 'botao', onclick: (e) => acao(e.currentTarget, async () => {
        await api.put('/seguranca/exigir-2fa', { exigir: !d.exigir_2fa_equipe });
        toast(d.exigir_2fa_equipe ? 'A exigência foi desligada.' : 'Agora a equipe precisa usar duas etapas.', 'ok');
        recarregar();
      }) }, icone('escudo'), d.exigir_2fa_equipe ? 'Deixar de exigir' : 'Exigir de toda a equipe') : null)),

    el('div', { style: 'margin-top:18px' }, cartao('Acessos dos clientes ao Internet Bank', tabela({
      colunas: [
        { titulo: 'Cliente', conteudo: (u) => u.cliente },
        { titulo: 'Pessoa', conteudo: (u) => el('span', {}, u.nome, el('span', { class: 'sub' }, u.email)) },
        { titulo: 'Duas etapas', conteudo: (u) => selo(u.totp_ativo ? 'ok' : 'nao', { ok: ['Ativa', 'ok'], nao: ['Sem 2FA', 'neutra'] }) },
        { titulo: 'Último acesso', conteudo: (u) => (u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca entrou') },
        { titulo: '', dir: true, conteudo: (u) => (u.totp_ativo
          ? el('button', { class: 'botao sutil pequeno', onclick: async (e) => {
            const ok = await confirmar({ titulo: 'Redefinir duas etapas', texto: `${u.nome} (${u.cliente}) vai configurar de novo no próximo acesso.`, confirmarTexto: 'Redefinir', perigo: true });
            if (ok) acao(e.currentTarget, async () => { await api.post(`/seguranca/acessos/${u.id}/redefinir-2fa`, {}); toast('Redefinida.'); recarregar(); });
          } }, 'Redefinir') : null) },
      ],
      itens: d.acessos_clientes,
      vazio: 'Nenhum acesso de cliente criado.',
    }))),
  );
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
