/** Telas do painel do master: a plataforma inteira. */
import {api, qs} from './api.js';
import {
  el, limpar, icone, toast, acao, confirmar, formModal, modal, campo, escolha, marcar, lerForm, inteiro,
  porcento, dataHora, desde, dinheiro, PERFIS, repetir, lerNumero,
} from './ui.js';
import {
  cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo, vazio, campoBusca, seletor, cartaoDesfechos,
  cartaoTempos, telaRelatorios,
} from './comum.js';

// ---------- Dashboard ----------

async function dashboard(ctx) {
  const conteudo = el('div');
  const desenhar = async () => {
    const d = await api.get('/master/painel');
    limpar(conteudo,
      el('div', { class: 'indicadores' },
        indicador('Empresas ativas', inteiro(d.totais.empresas_ativas), `${inteiro(d.totais.atendentes)} atendente(s) no total`, 'empresas', 'azul'),
        indicador('Conversas em aberto', inteiro(d.totais.conversas_abertas), 'agora, em todas as empresas', 'conversa', 'verde'),
        indicador('Conversas no mês', inteiro(d.totais.conversas_mes), `${porcento(d.mes.taxa_resolucao_ia)} resolvidas pela IA`, 'robo', 'roxo'),
        indicador('Custo da IA no mês', dinheiro(d.mes.ia.custo_centavos), `${inteiro(d.mes.ia.respostas)} resposta(s) geradas`, 'dinheiro', 'laranja')),
      el('div', { class: 'grade-2' }, cartaoDesfechos(d.mes), cartaoTempos(d.mes)),
      cartao('Empresas', tabela(['Empresa', '^Situação', '>Em aberto', '>Conversas (mês)', '>IA (mês)', 'Limite IA', '^Atendentes', '^Números'],
        d.empresas.map((e) => el('tr', { class: 'clicavel', onclick: () => ctx.ir('dashboard', e.id) },
          td(el('strong', {}, e.nome)),
          td(el('span', { class: `etiqueta ${e.status === 'ativa' ? 'ok' : 'erro'}` }, e.status), 'centro'),
          td(inteiro(e.abertas), 'dir num'),
          td(inteiro(e.conversas_mes), 'dir num'),
          td(inteiro(e.ia_mes), 'dir num'),
          td(e.limite_ia_mes ? `${porcento((e.ia_mes / e.limite_ia_mes) * 100)} de ${inteiro(e.limite_ia_mes)}` : 'sem limite'),
          td(inteiro(e.atendentes), 'centro num'),
          td(e.numeros ? icone('ok') : el('span', { class: 'etiqueta erro' }, 'falta'), 'centro'))),
      'Nenhuma empresa cadastrada.')));
  };
  limpar(ctx.conteudo, conteudo);
  await desenhar();
  ctx.parar(repetir(desenhar, 20_000));
}

// ---------- Empresas ----------

async function empresas(ctx) {
  const estado = { busca: '', status: '' };
  const lista = el('div');
  const recarregar = async () => {
    const { itens } = await api.get(`/master/empresas${qs(estado)}`);
    limpar(lista, cartao(null, tabela(['Empresa', 'CNPJ/CPF', '^Situação', '^IA', '^Atendentes', '>Em aberto', '>Conversas (mês)', '>IA (mês)', ''],
      itens.map((e) => el('tr', { class: 'clicavel', onclick: () => ctx.ir('dashboard', e.id) },
        td(el('div', {}, el('strong', {}, e.nome), e.email ? el('div', { class: 'pequeno mudo' }, e.email) : null,
          e.motivo_bloqueio ? el('div', { class: 'pequeno' }, el('span', { class: 'etiqueta erro' }, e.motivo_bloqueio)) : null)),
        td(e.documento ?? '—'),
        td(el('span', { class: `etiqueta ${e.status === 'ativa' ? 'ok' : 'erro'}` }, e.status), 'centro'),
        td(e.ia_ativa ? icone('robo') : el('span', { class: 'mudo' }, 'desligada'), 'centro'),
        td(`${inteiro(e.atendentes)}/${inteiro(e.limite_atendentes)}`, 'centro'),
        td(inteiro(e.conversas_abertas), 'dir num'),
        td(inteiro(e.conversas_mes), 'dir num'),
        td(e.limite_ia_mes ? `${inteiro(e.ia_mes)}/${inteiro(e.limite_ia_mes)}` : inteiro(e.ia_mes), 'dir num'),
        td(ctx.soMaster ? el('div', { class: 'linha', style: 'gap:4px' },
          botaoIcone('editar', 'Editar', () => editar(e)),
          botaoIcone(e.status === 'ativa' ? 'cadeado' : 'aberto', e.status === 'ativa' ? 'Bloquear' : 'Desbloquear', () => bloquear(e)),
          botaoIcone('lixo', 'Excluir', () => excluir(e), 'perigo')) : null, 'dir'))),
    'Nenhuma empresa.')));
  };

  const form = (e = {}) => [
    campo('Nome', { name: 'nome', value: e.nome ?? '', required: true, maxlength: 160 }),
    campo('CNPJ ou CPF', { name: 'documento', value: e.documento ?? '', inputmode: 'numeric' }),
    campo('E-mail', { name: 'email', value: e.email ?? '', type: 'email' }),
    campo('Telefone', { name: 'telefone', value: e.telefone ?? '' }),
    el('div', { class: 'grade-2' },
      campo('Limite de atendentes', { name: 'limite_atendentes', type: 'number', value: e.limite_atendentes ?? 5, min: 0, max: 500 }),
      campo('Limite de mensagens da IA por mês (0 = sem limite)', { name: 'limite_ia_mes', type: 'number', value: e.limite_ia_mes ?? 2000, min: 0 })),
  ];

  const criar = () => formModal('Nova empresa', () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
      'A empresa nasce com duas filas (Atendimento e Financeiro), etiquetas e a ZOE ligada. '
      + 'Depois é só cadastrar o número de WhatsApp e a base de conhecimento.'),
    ...form(),
  ], async (d) => {
    const nova = await api.post('/master/empresas', d);
    toast('Empresa criada.');
    await recarregar();
    ctx.ir('dashboard', nova.id);
  }, { largo: true });

  const editar = (e) => formModal(`Editar ${e.nome}`, () => form(e), async (d) => {
    await api.patch(`/master/empresas/${e.id}`, d);
    toast('Empresa salva.');
    ctx.renomearEmpresa(e.id, d.nome);
    await recarregar();
  }, { largo: true });

  const bloquear = (e) => {
    if (e.status !== 'ativa') {
      return acao(null, async () => {
        await api.post(`/master/empresas/${e.id}/bloquear`, { bloquear: false });
        toast('Empresa desbloqueada.');
        await recarregar();
      });
    }
    return formModal(`Bloquear ${e.nome}`, () => [
      el('p', { class: 'mudo' }, 'A equipe da empresa perde o acesso e o webhook do WhatsApp dela para de responder na hora.'),
      campo('Motivo', { name: 'motivo', required: true, maxlength: 300 }),
    ], async (d) => {
      await api.post(`/master/empresas/${e.id}/bloquear`, { bloquear: true, motivo: d.motivo });
      toast('Empresa bloqueada.');
      await recarregar();
    }, { rotulo: 'Bloquear' });
  };

  const excluir = (e) => formModal(`Excluir ${e.nome}`, () => [
    el('p', { class: 'mudo' }, 'A empresa sai da plataforma: ninguém mais entra e o WhatsApp dela para. O histórico de atendimento fica guardado.'),
    campo(`Digite "${e.nome}" para confirmar`, { name: 'confirmar_nome', required: true }),
  ], async (d) => {
    await api.del(`/master/empresas/${e.id}`, d);
    toast('Empresa excluída.');
    await recarregar();
  }, { rotulo: 'Excluir' });

  limpar(ctx.conteudo, acoesTopo(
    el('div', { class: 'filtros livre' },
      campoBusca(estado.busca, (t) => { estado.busca = t; recarregar(); }, 'Nome ou CNPJ'),
      seletor('Situação', { '': 'Todas', ativa: 'Ativa', bloqueada: 'Bloqueada' }, estado.status, (v) => { estado.status = v; recarregar(); })),
    ctx.soMaster ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova empresa') : null), lista);
  await recarregar();
}

// ---------- Usuários ----------

async function usuarios(ctx) {
  const lista = el('div');
  const empresasAtivas = (await api.get('/master/empresas')).itens;

  const recarregar = async () => {
    const { itens } = await api.get('/master/usuarios');
    limpar(lista, cartao(null, tabela(['Pessoa', 'Empresa', 'Perfil', '^Disponível', 'Último acesso', '^Ativo', ''],
      itens.map((u) => el('tr', {},
        td(el('div', {}, el('strong', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email))),
        td(u.empresa_nome ?? el('span', { class: 'etiqueta' }, 'plataforma')),
        td(PERFIS[u.perfil]),
        td(['atendente', 'cliente'].includes(u.perfil) ? el('span', { class: `situacao ${u.disponivel ? 'ok' : ''}` }, u.disponivel ? 'sim' : 'não') : '—', 'centro'),
        td(u.ultimo_acesso ? desde(u.ultimo_acesso) : 'nunca'),
        td(u.ativo ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'),
        td(botaoIcone('editar', 'Editar', () => editar(u)), 'dir'))))));
  };

  const criar = () => formModal('Novo usuário', () => {
    const perfil = escolha('Perfil', 'perfil', PERFIS, 'atendente');
    const empresa = escolha('Empresa (não se aplica a master e suporte)', 'empresa_id', { '': '—', ...Object.fromEntries(empresasAtivas.map((e) => [e.id, e.nome])) }, '');
    return [
      campo('Nome', { name: 'nome', required: true, maxlength: 160 }),
      campo('E-mail', { name: 'email', type: 'email', required: true }),
      perfil, empresa,
      campo('Senha (vazio gera provisória para usuário de empresa)', { name: 'senha', type: 'password', minlength: 8, autocomplete: 'new-password' }),
    ];
  }, async (d) => {
    if (!d.senha) delete d.senha;
    if (!d.empresa_id) delete d.empresa_id;
    const r = await api.post('/master/usuarios', d);
    await recarregar();
    if (r.senha_provisoria) {
      modal('Usuário criado', (fechar) => [
        el('pre', { class: 'json' }, `${r.usuario.email}\n${r.senha_provisoria}`),
        el('p', { class: 'mudo pequeno' }, 'A senha provisória não aparece de novo.'),
        el('div', { class: 'linha entre' }, el('span'), el('button', { class: 'btn primario', onclick: () => fechar() }, 'Entendi')),
      ]);
    } else toast('Usuário criado.');
  }, { largo: true });

  const editar = (u) => formModal(`Editar ${u.nome}`, () => [
    campo('Nome', { name: 'nome', value: u.nome, required: true, maxlength: 160 }),
    ['atendente', 'cliente'].includes(u.perfil) ? campo('Máximo de conversas ao mesmo tempo', { name: 'max_simultaneas', type: 'number', value: u.max_simultaneas, min: 1, max: 50 }) : null,
    campo('Nova senha (vazio mantém)', { name: 'senha', type: 'password', minlength: 8, autocomplete: 'new-password' }),
    marcar('Ativo', { name: 'ativo', checked: u.ativo }),
  ], async (d) => {
    if (!d.senha) delete d.senha;
    await api.patch(`/master/usuarios/${u.id}`, d);
    toast('Usuário salvo.');
    await recarregar();
  });

  limpar(ctx.conteudo, acoesTopo(el('span'), el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Novo usuário')), lista);
  await recarregar();
}

// ---------- Segurança ----------

async function seguranca(ctx) {
  const conteudo = el('div');
  const recarregar = async () => {
    const d = await api.get('/master/seguranca');
    limpar(conteudo,
      cartao('Acessos recusados (24 h)',
        tabela(['Quando', 'E-mail', 'IP', 'Motivo'], d.recusados.map((r) => el('tr', {},
          td(dataHora(r.criado_em)), td(r.email ?? '—'), td(el('code', {}, r.ip ?? '—')), td(r.motivo))),
        'Nenhum acesso recusado nas últimas 24 horas.'),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
          'Aqui aparecem também os webhooks recusados por assinatura inválida — útil quando o App secret do número está errado.')),
      cartao('IPs bloqueados',
        tabela(['IP', 'Motivo', 'Desde', ''], d.ips.map((i) => el('tr', {},
          td(el('code', {}, i.ip)), td(i.motivo ?? '—'), td(dataHora(i.criado_em)),
          td(botaoIcone('lixo', 'Desbloquear', async () => { await api.del(`/master/seguranca/ips/${encodeURIComponent(i.ip)}`); toast('IP desbloqueado.'); await recarregar(); }), 'dir'))),
        'Nenhum IP bloqueado.'),
        el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: bloquearIp }, icone('cadeado'), 'Bloquear IP'))),
      cartao('Registro de atividades',
        tabela(['Quando', 'Quem', 'Empresa', 'Ação', 'Alvo', 'IP'], d.auditoria.map((a) => el('tr', {},
          td(dataHora(a.criado_em)), td(a.usuario_nome ?? '—'), td(a.empresa_nome ?? '—'), td(a.acao), td(a.alvo ?? '—'), td(el('code', {}, a.ip ?? '—')))),
        'Nada registrado.')));
  };

  const bloquearIp = () => formModal('Bloquear IP', () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' }, 'O IP bloqueado não acessa o painel nem a API de integração. O webhook da Meta não é afetado.'),
    campo('IP', { name: 'ip', required: true, maxlength: 60 }),
    campo('Motivo', { name: 'motivo', maxlength: 200 }),
  ], async (d) => {
    await api.post('/master/seguranca/ips', d);
    toast('IP bloqueado.');
    await recarregar();
  });

  limpar(ctx.conteudo, conteudo);
  await recarregar();
}

// ---------- Diagnóstico ----------

async function diagnostico(ctx) {
  const conteudo = el('div', {}, el('p', { class: 'mudo' }, 'Verificando…'));
  const desenhar = async () => {
    const d = await api.get('/master/diagnostico');
    const ICONE = { ok: 'ok', aviso: 'alerta', erro: 'alerta' };
    limpar(conteudo,
      cartao('Verificações', el('div', { class: 'verificacoes' }, d.verificacoes.map((v) => el('div', { class: `verificacao ${v.situacao}` },
        icone(ICONE[v.situacao]), el('div', {}, el('strong', {}, v.nome), el('div', { class: 'pequeno' }, v.detalhe)))))),
      cartao('Números de WhatsApp',
        tabela(['Número', 'Empresa', '^Situação', 'Nome verificado', 'Qualidade', 'Detalhe'], d.numeros.map((n) => el('tr', {},
          td(el('div', {}, el('strong', {}, n.nome), el('div', { class: 'pequeno mudo' }, n.telefone))),
          td(`#${n.empresa_id}`),
          td(el('span', { class: `etiqueta ${n.ok ? 'ok' : 'erro'}` }, n.estado), 'centro'),
          td(n.nome_verificado ?? '—'), td(n.qualidade ?? '—'),
          td(el('span', { class: 'pequeno' }, n.erro ?? '—')))),
        'Nenhum número ativo na plataforma.')));
  };
  limpar(ctx.conteudo, acoesTopo(el('span'), botao('Verificar de novo', 'primario', desenhar)), conteudo);
  await desenhar();
}

// ---------- Configurações ----------

async function configuracoes(ctx) {
  const c = await api.get('/master/configuracoes');
  const f = el('form', { class: 'form colunas' },
    cartao('Plataforma',
      campo('Nome da plataforma', { name: 'nome_plataforma', value: c.nome_plataforma, required: true, maxlength: 60 }),
      el('div', { class: 'grade-2' },
        campo('Limite de atendentes das empresas novas', { name: 'limite_atendentes_padrao', type: 'number', value: c.limite_atendentes_padrao, min: 0 }),
        campo('Limite de mensagens da IA por mês (empresas novas)', { name: 'limite_ia_mes_padrao', type: 'number', value: c.limite_ia_mes_padrao, min: 0 }))),
    cartao('Atendimento',
      campo('Encerrar por abandono depois de (minutos)', { name: 'abandono_min', type: 'number', value: c.abandono_min, min: 0 }),
      campo('Alerta de espera na fila (minutos)', { name: 'alerta_espera_min', type: 'number', value: c.alerta_espera_min, min: 1 }),
      campo('Guardar conversas encerradas por (dias, 0 = para sempre)', { name: 'retencao_dias', type: 'number', value: c.retencao_dias, min: 0 })),
    cartao('Preço da IA (para o custo estimado nos relatórios)',
      el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
        'Em centavos de real por milhão de tokens. Os padrões seguem a tabela do modelo de IA padrão convertida em reais; '
        + 'ajuste quando o preço do modelo ou o câmbio mudarem. Isso não altera a cobrança do provedor de IA, só o cálculo mostrado aqui.'),
      el('div', { class: 'grade-2' },
        campo('Entrada (por milhão de tokens)', { name: 'ia_preco_entrada_milhao', type: 'number', value: c.ia_preco_entrada_milhao, min: 0 }),
        campo('Saída (por milhão de tokens)', { name: 'ia_preco_saida_milhao', type: 'number', value: c.ia_preco_saida_milhao, min: 0 })),
      campo('Leitura do cache (por milhão de tokens)', { name: 'ia_preco_cache_milhao', type: 'number', value: c.ia_preco_cache_milhao, min: 0 })),
    cartao('Preço da Meta por mensagem',
      el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
        'O que a Meta cobra por mensagem ENTREGUE que a empresa inicia. Serviço (o cliente escreveu e a resposta saiu em até 24 h) '
        + 'é de graça e não entra aqui. A tabela em reais vale para as empresas cobradas em real; a em dólar, como a Meta publica, '
        + 'para as cobradas em dólar. Confira a tabela do Brasil no painel da Meta — ela muda.'),
      el('div', { class: 'grade-2' },
        el('div', {},
          el('strong', { class: 'pequeno' }, 'Em reais (R$)'),
          campoPreco('Utilidade', 'meta_brl_utilidade', c.wa_preco_utilidade / 1000, 3),
          campoPreco('Autenticação', 'meta_brl_autenticacao', c.wa_preco_autenticacao / 1000, 3),
          campoPreco('Marketing', 'meta_brl_marketing', c.wa_preco_marketing / 1000, 3)),
        el('div', {},
          el('strong', { class: 'pequeno' }, 'Em dólar (US$)'),
          campoPreco('Utilidade', 'meta_usd_utilidade', c.wa_preco_utilidade_usd / 1_000_000, 4),
          campoPreco('Autenticação', 'meta_usd_autenticacao', c.wa_preco_autenticacao_usd / 1_000_000, 4),
          campoPreco('Marketing', 'meta_usd_marketing', c.wa_preco_marketing_usd / 1_000_000, 4))),
      campoPreco('Cotação padrão do dólar (R$), para empresas que não informaram a delas', 'meta_cotacao', c.wa_cotacao_padrao / 10_000, 4)),
    el('div', { class: 'linha entre' }, el('span'), el('button', { class: 'btn primario' }, 'Salvar')));

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('.btn.primario'), async () => {
      const d = lerForm(f);
      // Os preços entram como o humano escreve ("0,0068") e o servidor guarda inteiros:
      // milésimos de real, milionésimos de dólar e a cotação ×10000.
      const num = (x) => lerNumero(x);
      const conv = { meta_brl_utilidade: ['wa_preco_utilidade', 1000], meta_brl_autenticacao: ['wa_preco_autenticacao', 1000],
        meta_brl_marketing: ['wa_preco_marketing', 1000], meta_usd_utilidade: ['wa_preco_utilidade_usd', 1_000_000],
        meta_usd_autenticacao: ['wa_preco_autenticacao_usd', 1_000_000], meta_usd_marketing: ['wa_preco_marketing_usd', 1_000_000],
        meta_cotacao: ['wa_cotacao_padrao', 10_000] };
      for (const [campo, [chave, fator]] of Object.entries(conv)) {
        if (d[campo] !== undefined && d[campo] !== '') d[chave] = Math.round(num(d[campo]) * fator);
        delete d[campo];
      }
      await api.patch('/master/configuracoes', d);
      toast('Configurações salvas. Recarregue para ver o nome novo no menu.');
    });
  });
  limpar(ctx.conteudo, f);
}

/** Campo de preço com casas decimais, escrito como a gente lê ("0,0068"). */
function campoPreco(rotulo, nome, valor, casas) {
  return campo(rotulo, { name: nome, inputmode: 'decimal', value: Number(valor ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas, useGrouping: false }) });
}

// ---------- Relatórios ----------

const relatorios = (ctx) => telaRelatorios(ctx, '/master/relatorios', {
  extras: (d) => [cartao('Por empresa', tabela(['Empresa', '>Conversas', '>Resolvidas pela ZOE', '>Transferidas', '>CSAT'],
    d.por_empresa.map((e) => el('tr', {}, td(e.nome), td(inteiro(e.conversas), 'dir num'), td(inteiro(e.resolvidas_ia), 'dir num'),
      td(inteiro(e.transferidas), 'dir num'), td(e.csat === null ? '—' : e.csat.toLocaleString('pt-BR'), 'dir num'))))) ],
});

import { telaTelefoniaMaster } from './telefonia-master.js';

export const TELAS_MASTER = { telefonia: telaTelefoniaMaster, dashboard, empresas, usuarios, seguranca, diagnostico, relatorios, configuracoes };
