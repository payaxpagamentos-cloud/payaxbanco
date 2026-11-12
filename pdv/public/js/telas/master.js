import { api } from '../api.js';
import {
  el, limpar, dinheiro, inteiro, campo, escolha, marcar, formModal, perguntar, toast, acao, icone, lerForm,
  etiqueta, pessoa, dataHora, dataBr, PERFIS,
} from '../ui.js';

/** Visão geral da plataforma: o que cada empresa recebeu hoje e o que está pendente no IXC. */
async function telaPainel(ctx) {
  const raiz = el('div', { class: 'coluna' });
  limpar(ctx.conteudo, raiz);
  const { empresas, serie } = await api.get('/master/painel');
  const totalHoje = empresas.reduce((s, e) => s + e.total_hoje, 0);
  const pendentes = empresas.reduce((s, e) => s + e.baixas_pendentes, 0);
  const divergencias = empresas.reduce((s, e) => s + e.divergencias, 0);

  limpar(raiz,
    el('div', { class: 'grade-dash' },
      indicador('Recebido hoje', dinheiro(totalHoje), 'dinheiro'),
      indicador('Empresas ativas', inteiro(empresas.filter((e) => e.status === 'ativa').length), 'empresas'),
      indicador('Baixas pendentes no IXC', inteiro(pendentes), 'sincronizar', pendentes ? 'aviso' : ''),
      indicador('Divergências abertas', inteiro(divergencias), 'alerta', divergencias ? 'erro' : '')),
    el('div', { class: 'cartao' }, el('h2', {}, 'Empresas'),
      el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, ['Empresa', 'Recebido hoje', 'Caixas abertos', 'Maquininhas', 'Baixas pendentes', 'Divergências', ''].map((t) => el('th', {}, t)))),
        el('tbody', {}, empresas.map((e) => el('tr', { class: 'clicavel', onclick: () => ctx.ir('conferencia', e.id) },
          el('td', {}, el('strong', {}, e.nome), e.status !== 'ativa' ? el('div', {}, etiqueta('Bloqueada', 'erro')) : null),
          el('td', { class: 'num dir' }, dinheiro(e.total_hoje), el('div', { class: 'pequeno mudo' }, `${e.recebimentos_hoje} atendimento(s)`)),
          el('td', { class: 'num dir' }, inteiro(e.caixas_abertos)),
          el('td', { class: 'num dir' }, inteiro(e.maquininhas)),
          el('td', { class: 'num dir' }, e.baixas_pendentes ? el('span', { class: 'aviso' }, inteiro(e.baixas_pendentes)) : '0'),
          el('td', { class: 'num dir' }, e.divergencias ? el('span', { class: 'aviso' }, inteiro(e.divergencias)) : '0'),
          el('td', { class: 'dir' }, el('a', { class: 'btn pequeno', href: `#/empresa/${e.id}/conferencia` }, 'Abrir'))))))),
    el('div', { class: 'cartao' }, el('h2', {}, 'Recebido por dia (30 dias)'),
      serie.length ? el('table', { class: 'tabela' }, el('tbody', {}, serie.slice().reverse().map((d) => el('tr', {},
        el('td', {}, dataBr(d.data)), el('td', { class: 'pequeno mudo' }, `${d.quantidade} atendimento(s)`), el('td', { class: 'num dir' }, dinheiro(d.total_centavos))))))
        : el('p', { class: 'mudo' }, 'Nenhum recebimento ainda.')));
}

const indicador = (rotulo, valor, ic, tipo = '') => el('div', { class: 'indicador com-icone' },
  el('div', { class: `ic ${tipo}` }, icone(ic)),
  el('div', { class: 'corpo' }, el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor' }, valor)));

/** Empresas atendidas. */
async function telaEmpresas(ctx) {
  const raiz = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, raiz);

  async function carregar() {
    const { itens } = await api.get('/master/empresas');
    limpar(raiz, el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, 'Empresas'),
      ctx.soMaster ? el('button', { class: 'btn primario', onclick: () => editar(null) }, 'Nova empresa') : null),
      el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, ['Empresa', 'CNPJ/CPF', 'Contato', 'Situação', ''].map((t) => el('th', {}, t)))),
        el('tbody', {}, itens.map((e) => el('tr', {},
          el('td', {}, el('strong', {}, e.nome)),
          el('td', { class: 'pequeno mudo' }, e.documento ?? '—'),
          el('td', { class: 'pequeno mudo' }, [e.email, e.telefone].filter(Boolean).join(' · ')),
          el('td', {}, e.status === 'ativa' ? etiqueta('Ativa', 'ok') : etiqueta('Bloqueada', 'erro'),
            e.motivo_bloqueio ? el('div', { class: 'pequeno mudo' }, e.motivo_bloqueio) : null),
          el('td', { class: 'dir' }, el('div', { class: 'linha', style: 'gap:6px;justify-content:flex-end' },
            el('a', { class: 'btn pequeno', href: `#/empresa/${e.id}/conferencia` }, 'Abrir PDV'),
            ctx.soMaster ? el('button', { class: 'btn pequeno', onclick: () => editar(e) }, icone('editar'), 'Editar') : null,
            ctx.soMaster ? el('button', { class: 'btn pequeno perigo', onclick: () => bloquear(e) }, e.status === 'ativa' ? 'Bloquear' : 'Liberar') : null)))))));
  }

  function editar(e) {
    formModal(e ? e.nome : 'Nova empresa', () => [
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: e?.nome ?? '' }),
      campo('CNPJ ou CPF', { name: 'documento', maxlength: 20, value: e?.documento ?? '' }),
      el('div', { class: 'duas' },
        campo('E-mail', { name: 'email', type: 'email', value: e?.email ?? '' }),
        campo('Telefone', { name: 'telefone', value: e?.telefone ?? '' })),
    ], async (d) => {
      if (e) await api.patch(`/master/empresas/${e.id}`, d);
      else {
        const nova = await api.post('/master/empresas', d);
        toast(`Empresa criada com a loja "Matriz" e o "Caixa 1". Configure o IXC em Configurações.`);
        ctx.ir('configuracoes', nova.id);
        return;
      }
      toast('Empresa salva.');
      await carregar();
    });
  }

  function bloquear(e) {
    acao(null, async () => {
      if (e.status === 'ativa') {
        const motivo = await perguntar('Bloquear empresa', 'Motivo do bloqueio');
        if (!motivo) return;
        await api.patch(`/master/empresas/${e.id}`, { status: 'bloqueada', motivo_bloqueio: motivo });
      } else {
        await api.patch(`/master/empresas/${e.id}`, { status: 'ativa' });
      }
      toast('Situação alterada.');
      await carregar();
    });
  }

  await carregar();
}

/** Usuários da plataforma e das empresas. */
async function telaUsuarios(ctx) {
  const raiz = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, raiz);

  async function carregar() {
    const [{ itens, perfis }, empresas] = await Promise.all([api.get('/master/usuarios'), api.get('/master/empresas').then((x) => x.itens)]);
    const opcoesEmpresa = { '': 'Plataforma (sem empresa)', ...Object.fromEntries(empresas.map((e) => [e.id, e.nome])) };
    limpar(raiz, el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, 'Usuários'),
      ctx.soMaster ? el('button', { class: 'btn primario', onclick: () => editar(null, perfis, opcoesEmpresa) }, 'Novo usuário') : null),
      el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, ['Pessoa', 'Perfil', 'Empresa', 'Último acesso', ''].map((t) => el('th', {}, t)))),
        el('tbody', {}, itens.map((u) => el('tr', {},
          el('td', {}, pessoa(u.nome, u.email)),
          el('td', {}, PERFIS[u.perfil] ?? u.perfil),
          el('td', { class: 'pequeno mudo' }, u.empresa_nome ?? 'Plataforma'),
          el('td', { class: 'pequeno mudo' }, u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca'),
          el('td', { class: 'dir' }, u.ativo ? null : etiqueta('Inativo', ''),
            ctx.soMaster ? el('button', { class: 'btn pequeno', onclick: () => editar(u, perfis, opcoesEmpresa) }, icone('editar'), 'Editar') : null))))));
  }

  function editar(u, perfis, opcoesEmpresa) {
    formModal(u ? u.nome : 'Novo usuário', () => [
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: u?.nome ?? '' }),
      u ? null : campo('E-mail', { name: 'email', type: 'email', required: true }),
      el('div', { class: 'duas' },
        escolha('Perfil', 'perfil', Object.fromEntries(perfis.map((p) => [p, PERFIS[p] ?? p])), u?.perfil ?? 'operador'),
        u ? null : escolha('Empresa', 'empresa_id', opcoesEmpresa, '')),
      campo(u ? 'Nova senha (deixe vazio para manter)' : 'Senha (mínimo 8 caracteres)',
        { name: 'senha', type: 'password', required: !u, minlength: 8, autocomplete: 'new-password' }),
      u ? marcar('Usuário ativo', { name: 'ativo', checked: !!u.ativo }) : null,
    ], async (d) => {
      const corpo = { ...d, empresa_id: d.empresa_id || null };
      if (u && !d.senha) delete corpo.senha;
      if (u) await api.patch(`/master/usuarios/${u.id}`, corpo);
      else await api.post('/master/usuarios', corpo);
      toast('Usuário salvo.');
      await carregar();
    });
  }

  await carregar();
}

/** Auditoria de toda a plataforma. */
async function telaAuditoria(ctx) {
  const raiz = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, raiz);
  const { itens } = await api.get('/master/auditoria?limite=200');
  limpar(raiz, el('h2', {}, 'Auditoria'),
    el('table', { class: 'tabela' },
      el('thead', {}, el('tr', {}, ['Quando', 'Quem', 'Empresa', 'Ação', 'Detalhes', 'IP'].map((t) => el('th', {}, t)))),
      el('tbody', {}, itens.map((a) => el('tr', {},
        el('td', { class: 'pequeno mudo' }, dataHora(a.criado_em)),
        el('td', {}, a.usuario_nome ?? 'sistema'),
        el('td', { class: 'pequeno mudo' }, a.empresa_nome ?? '—'),
        el('td', {}, a.acao.replace(/_/g, ' ')),
        el('td', { class: 'pequeno mudo' }, a.detalhes ? JSON.stringify(a.detalhes) : ''),
        el('td', { class: 'pequeno mudo' }, a.ip ?? ''))))));
}

/** Configurações da plataforma. */
async function telaConfiguracoesMaster(ctx) {
  const raiz = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, raiz);
  const c = await api.get('/master/configuracoes');
  const form = el('form', { class: 'form' },
    campo('Nome da plataforma', { name: 'nome_plataforma', value: c.nome_plataforma, maxlength: 60 }),
    el('div', { class: 'duas' },
      campo('Tentativas de baixa no IXC', { name: 'baixa_tentativas', type: 'number', min: 1, max: 100, value: c.baixa_tentativas }),
      campo('Intervalo da fila (segundos)', { name: 'fila_intervalo_s', type: 'number', min: 10, max: 3600, value: c.fila_intervalo_s })));
  const salvar = el('button', { class: 'btn primario' }, 'Salvar');
  const fila = el('button', { class: 'btn', type: 'button' }, icone('sincronizar'), 'Rodar a fila de baixas agora');
  fila.addEventListener('click', () => acao(fila, async () => {
    const r = await api.post('/master/fila', {});
    toast(`${r.baixados} baixa(s) feita(s), ${r.erros} com erro.`, !!r.erros);
  }));
  form.append(el('div', { class: 'linha entre' }, fila, salvar));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(salvar, async () => {
      await api.patch('/master/configuracoes', lerForm(form));
      toast('Configurações salvas. Recarregue para ver o novo nome.');
    });
  });
  limpar(raiz, el('h2', {}, 'Configurações da plataforma'),
    el('p', { class: 'mudo' }, 'A fila tenta de novo as baixas que o IXC recusou ou que ficaram sem resposta. Depois do número de tentativas, o recebimento espera alguém olhar na conferência.'),
    form);
}

export const TELAS_MASTER = {
  painel: telaPainel,
  empresas: telaEmpresas,
  usuarios: telaUsuarios,
  auditoria: telaAuditoria,
  configuracoes: telaConfiguracoesMaster,
};
