/** Telas do master (equipe da plataforma). */
import { api, qs } from './api.js';
import { el, limpar, dinheiro, dataHora, data, desde, inteiro, toast, campo, area, escolha, marcar, formModal, perguntar, confirmar, repetir, telefone, etiqueta, placa,
  TIPOS_EMPRESA, PERFIS, PROTOCOLOS, reaisCampo, centavos } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, painelMapa, painelIntegracoes, situacaoDiag, linhaDado } from './comum.js';
import { configPublica } from './mapa.js';
import { barras } from './graficos.js';

const listaEmpresas = () => api.get('/master/empresas');

// ---------- Dashboard ----------
async function telaDashboard(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get('/master/dashboard');
    limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:18px' },
      el('div', { class: 'grade' },
        indicador('Empresas ativas', inteiro(d.empresas.ativa ?? 0), d.empresas.bloqueada ? `${d.empresas.bloqueada} bloqueada(s)` : 'nenhuma bloqueada'),
        indicador('Veículos online', `${inteiro(d.veiculos.online)}/${inteiro(d.veiculos.total)}`, 'comunicaram nos últimos minutos', 'ok'),
        indicador('Rastreadores', inteiro(d.rastreadores.total), `${inteiro(d.rastreadores.instalados)} instalados · ${inteiro(d.rastreadores.estoque)} no estoque`),
        indicador('Mensagens hoje', inteiro(d.mensagens_hoje), d.conexoes_gt06 === null ? 'servidor GT06 desligado' : `${inteiro(d.conexoes_gt06)} GT06 conectado(s)`),
        indicador('Faturamento mensal', dinheiro(d.faturamento_mensal_centavos), 'veículos ativos × mensalidade'),
        indicador('Não cadastrados', inteiro(d.desconhecidos), 'equipamentos que tentaram enviar', d.desconhecidos ? 'aviso' : '')),
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c7' }, cartao('Mensagens recebidas por dia (14 dias)', barras(d.mensagens_por_dia.map((x) => ({
          rotulo: x.data.slice(8), valor: x.mensagens, titulo: `${data(x.data)}: ${inteiro(x.mensagens)} mensagem(ns)` }))))),
        el('div', { class: 'c5' }, cartao('Empresas', tabela(['Empresa', '>Veículos', '>Online', '>Alertas'], d.top_empresas.map((e) =>
          el('tr', { class: 'clicavel', onclick: () => { ctx.renomearEmpresa(e.id, e.nome); ctx.ir('dashboard', e.id); } }, td(e.nome),
            td(`${inteiro(e.veiculos)}/${inteiro(e.limite_veiculos)}`, 'dir num'), td(inteiro(e.online), 'dir num'),
            td(e.alertas_pendentes ? etiqueta(inteiro(e.alertas_pendentes), 'aviso') : '0', 'dir')))), 'Nenhuma empresa.'))),
      d.alertas_pendentes ? el('p', { class: 'pequeno mudo' }, `${inteiro(d.alertas_pendentes)} alerta(s) pendente(s) somando todas as empresas.`) : null));
  }, 15_000));
}

async function telaMapa(ctx) {
  await painelMapa(ctx, '/master/mapa', { mostrarEmpresa: true });
}

// ---------- Empresas ----------
async function formEmpresa(atual) {
  const cfg = atual ? null : await api.get('/master/configuracoes').catch(() => null);
  const e = atual ?? { tipo: 'frota', limite_veiculos: cfg?.limite_veiculos_padrao ?? 10, mensalidade_centavos: cfg?.mensalidade_padrao_centavos ?? 0,
    sem_comunicacao_min: cfg?.sem_comunicacao_padrao_min ?? 120 };
  return formModal(atual ? `Editar ${atual.nome}` : 'Nova empresa', () => [
    el('fieldset', {}, el('legend', {}, 'Empresa'),
      campo('Nome', { name: 'nome', required: true, maxlength: 160, value: e.nome ?? '' }),
      el('div', { class: 'duas' }, campo('CNPJ ou CPF', { name: 'documento', value: e.documento ?? '', inputmode: 'numeric' }), escolha('Tipo', 'tipo', TIPOS_EMPRESA, e.tipo)),
      el('div', { class: 'duas' }, campo('E-mail', { name: 'email', type: 'email', value: e.email ?? '' }), campo('Telefone', { name: 'telefone', type: 'tel', value: e.telefone ?? '' }))),
    el('fieldset', {}, el('legend', {}, 'Plano'),
      el('div', { class: 'tres' }, campo('Limite de veículos', { name: 'limite_veiculos', type: 'number', min: 0, required: true, value: e.limite_veiculos }),
        campo('Mensalidade por veículo (R$)', { name: 'mensalidade', inputmode: 'decimal', value: reaisCampo(e.mensalidade_centavos) }),
        campo('Alerta sem comunicação (min)', { name: 'sem_comunicacao_min', type: 'number', min: 0, value: e.sem_comunicacao_min }))),
    atual ? null : el('fieldset', {}, el('legend', {}, 'Primeiro administrador da empresa (opcional)'),
      el('div', { class: 'duas' }, campo('Nome', { name: 'adm_nome', maxlength: 120 }), campo('E-mail', { name: 'adm_email', type: 'email' })),
      campo('Senha inicial (mínimo 8)', { name: 'adm_senha', type: 'password', minlength: 8, autocomplete: 'new-password' })),
  ], async (d) => {
    const corpo = { nome: d.nome, documento: d.documento, tipo: d.tipo, email: d.email, telefone: d.telefone, limite_veiculos: d.limite_veiculos,
      mensalidade_centavos: centavos(d.mensalidade) ?? 0, sem_comunicacao_min: d.sem_comunicacao_min };
    if (atual) return api.put(`/master/empresas/${atual.id}`, corpo);
    if (d.adm_email) corpo.administrador = { nome: d.adm_nome, email: d.adm_email, senha: d.adm_senha };
    return api.post('/master/empresas', corpo);
  }, { largo: true, rotulo: atual ? 'Salvar' : 'Criar empresa' });
}

async function telaEmpresas(ctx) {
  const estado = { busca: '', tipo: '', status: '' };
  const lista = el('div');
  const busca = el('input', { placeholder: 'Empresa ou CNPJ…', value: estado.busca });
  const tipo = escolha(null, 'tipo', { '': 'Tipo', ...TIPOS_EMPRESA }, '');
  const status = escolha(null, 'status', { '': 'Status', ativa: 'Ativa', bloqueada: 'Bloqueada' }, '');
  const filtrar = () => { Object.assign(estado, { busca: busca.value, tipo: tipo.value, status: status.value }); carregar(); };
  busca.addEventListener('keydown', (e) => { if (e.key === 'Enter') filtrar(); });

  async function carregar() {
    const empresas = await api.get(`/master/empresas${qs(estado)}`);
    limpar(lista, tabela(['Empresa', 'Tipo', '^Veículos', '^Online', '^Rastreadores', '^Alertas', '>Mensal', '^Ações'], empresas.map((e) => el('tr', { class: 'clicavel', onclick: () => {
      ctx.renomearEmpresa(e.id, e.nome);
      ctx.ir('dashboard', e.id);
    } },
      td([el('strong', {}, e.nome), e.status === 'bloqueada' ? el('div', {}, el('span', { class: 'etiqueta erro', title: e.motivo_bloqueio ?? '' }, `bloqueada: ${e.motivo_bloqueio ?? ''}`)) : null]),
      td(TIPOS_EMPRESA[e.tipo]), td(`${e.veiculos}/${e.limite_veiculos}`, 'centro num'), td(inteiro(e.online), 'centro num'), td(inteiro(e.rastreadores), 'centro num'),
      td(e.alertas_pendentes ? etiqueta(inteiro(e.alertas_pendentes), 'aviso') : '0', 'centro'), td(dinheiro(e.mensalidade_centavos * e.veiculos), 'dir num'),
      el('td', { class: 'acoes' },
        botaoIcone('editar', 'Editar', async () => { if (await formEmpresa(await api.get(`/master/empresas/${e.id}`))) { toast('Empresa salva.'); carregar(); } }),
        e.status === 'bloqueada'
          ? botaoIcone('aberto', 'Desbloquear', async () => {
            if (!await confirmar('Desbloquear empresa', `${e.nome} volta a ter as posições gravadas e os usuários voltam a entrar.`, 'Desbloquear')) return;
            await api.post(`/master/empresas/${e.id}/desbloquear`);
            toast('Empresa desbloqueada.');
            carregar();
          })
          : botaoIcone('cadeado', 'Bloquear', async () => {
            const motivo = await perguntar(`Bloquear ${e.nome}`, 'Motivo (os usuários da empresa não entram e as posições deixam de ser gravadas)');
            if (!motivo) return;
            await api.post(`/master/empresas/${e.id}/bloquear`, { motivo });
            toast('Empresa bloqueada.');
            carregar();
          }),
        ctx.soMaster ? botaoIcone('lixo', 'Excluir', async () => {
          const nome = await perguntar(`Excluir ${e.nome}`, 'Digite o nome da empresa para confirmar. Usuários e chaves são desativados e os rastreadores voltam ao estoque; o histórico fica guardado até a retenção.');
          if (!nome) return;
          await api.del(`/master/empresas/${e.id}`, { confirmacao: nome });
          toast('Empresa excluída.');
          carregar();
        }, 'perigo') : null))), 'Nenhuma empresa encontrada.'));
  }
  limpar(ctx.conteudo, el('section', { class: 'cartao grande' },
    el('div', { class: 'filtros' }, busca, tipo, status, el('button', { class: 'btn primario largo', onclick: filtrar }, 'Filtrar')),
    lista,
    el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:16px' },
      el('button', { class: 'btn primario', onclick: async () => { if (await formEmpresa()) { toast('Empresa criada.'); carregar(); } } }, 'Nova empresa'))));
  await carregar();
}

// ---------- Rastreadores (estoque) ----------
async function telaRastreadores(ctx) {
  const empresas = await listaEmpresas();
  const nomesEmp = Object.fromEntries(empresas.map((e) => [e.id, e.nome]));
  const estado = { busca: '', situacao: '', empresa_id: '', protocolo: '' };
  const lista = el('div');
  const desconhecidos = el('div');
  const filtro = (rotulo, nome, opcoes) => {
    const s = escolha(null, nome, opcoes, estado[nome]);
    s.addEventListener('change', () => { estado[nome] = s.value; carregar(); });
    return el('label', { class: 'campo' }, rotulo, s);
  };
  const busca = el('input', { placeholder: 'IMEI, chip, modelo ou placa' });
  busca.addEventListener('change', () => { estado.busca = busca.value; carregar(); });

  const form = (r, padrao = {}) => formModal(r ? `Rastreador ${r.imei}` : 'Novo rastreador', () => [
    el('div', { class: 'duas' }, campo('IMEI / identificador', { name: 'imei', required: true, maxlength: 40, value: r?.imei ?? padrao.imei ?? '', class: 'mono' }),
      escolha('Protocolo', 'protocolo', PROTOCOLOS, r?.protocolo ?? padrao.protocolo ?? 'gt06')),
    campo('Modelo', { name: 'modelo', maxlength: 60, value: r?.modelo ?? '', placeholder: 'Ex.: GT06N, J16, ST-901' }),
    el('div', { class: 'duas' }, campo('Número do chip', { name: 'chip_numero', inputmode: 'tel', value: r?.chip_numero ?? '' }),
      campo('Operadora do chip', { name: 'chip_operadora', maxlength: 40, value: r?.chip_operadora ?? '' })),
    escolha('Empresa', 'empresa_id', { '': 'Estoque (sem empresa)', ...nomesEmp }, r?.empresa_id ?? ''),
    r?.placa ? el('p', { class: 'aviso pequeno', style: 'margin:0' }, `Instalado em ${placa(r.placa)}. Trocar a empresa tira o rastreador do veículo.`) : null,
    area('Observações', { name: 'observacoes', maxlength: 300 }, r?.observacoes ?? ''),
  ], (d) => {
    const corpo = { ...d, empresa_id: d.empresa_id || null };
    return r ? api.put(`/master/rastreadores/${r.id}`, corpo) : api.post('/master/rastreadores', corpo);
  });

  async function carregar() {
    const [rs, desc] = await Promise.all([api.get(`/master/rastreadores${qs(estado)}`), api.get('/master/desconhecidos')]);
    limpar(lista, tabela(['IMEI', 'Modelo', 'Protocolo', 'Chip', 'Empresa', 'Veículo', 'Última comunicação', '^Ações'], rs.map((r) => el('tr', {},
      td([el('span', { class: 'mono' }, r.imei), r.conectado ? el('div', {}, etiqueta('conectado', 'ok')) : null]), td(r.modelo ?? '—'), td(PROTOCOLOS[r.protocolo]),
      td(r.chip_numero ? [telefone(r.chip_numero), r.chip_operadora ? el('div', { class: 'pequeno mudo' }, r.chip_operadora) : null] : '—'),
      td(r.empresa ?? etiqueta('estoque', 'info')), td(r.placa ? placa(r.placa) : '—'),
      td(r.ultima_comunicacao ? [dataHora(r.ultima_comunicacao), el('div', { class: 'pequeno mudo' }, desde(r.ultima_comunicacao))] : 'nunca'),
      el('td', { class: 'acoes' },
        botaoIcone('editar', 'Editar', async () => { if (await form(r)) { toast('Rastreador salvo.'); carregar(); } }),
        ctx.soMaster ? botaoIcone('lixo', 'Excluir', async () => {
          if (!await confirmar('Excluir rastreador', `Excluir ${r.imei}?`, 'Excluir')) return;
          await api.del(`/master/rastreadores/${r.id}`);
          toast('Rastreador excluído.');
          carregar();
        }, 'perigo') : null))), 'Nenhum rastreador.'));
    limpar(desconhecidos, desc.length ? cartao('Equipamentos não cadastrados',
      el('p', { class: 'mudo', style: 'margin-top:0' }, 'Tentaram enviar posições sem estar cadastrados. Cadastre para começar a receber.'),
      tabela(['IMEI', 'Protocolo', 'IP', 'Primeiro contato', 'Último contato', '>Mensagens', '^Ações'], desc.map((x) => el('tr', {},
        td(el('span', { class: 'mono' }, x.imei)), td(PROTOCOLOS[x.protocolo] ?? x.protocolo), td(el('span', { class: 'mono pequeno' }, x.ip ?? '—')),
        td(dataHora(x.primeiro_contato)), td(desde(x.ultimo_contato)), td(inteiro(x.mensagens), 'dir num'),
        el('td', { class: 'acoes' }, botao('Cadastrar', 'primario', async () => { if (await form(null, { imei: x.imei, protocolo: x.protocolo })) { toast('Rastreador cadastrado.'); carregar(); } }),
          botaoIcone('lixo', 'Ignorar', async () => { await api.del(`/master/desconhecidos/${encodeURIComponent(x.imei)}`); carregar(); }, 'perigo')))))) : null);
  }
  limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:18px' },
    el('div', { class: 'filtros livre' }, el('label', { class: 'campo' }, 'Buscar', busca),
      filtro('Situação', 'situacao', { '': 'Todos', estoque: 'No estoque', empresa: 'Na empresa, sem veículo', instalado: 'Instalado' }),
      filtro('Empresa', 'empresa_id', { '': 'Todas', ...nomesEmp }), filtro('Protocolo', 'protocolo', { '': 'Todos', ...PROTOCOLOS }),
      el('button', { class: 'btn primario', onclick: async () => { if (await form(null)) { toast('Rastreador cadastrado.'); carregar(); } } }, 'Novo rastreador')),
    desconhecidos, cartao(null, lista)));
  await carregar();
}

// ---------- Permissões e usuários ----------
async function telaUsuarios(ctx) {
  const empresas = await listaEmpresas();
  const estado = { empresa_id: '', perfil: '', busca: '' };
  const lista = el('div');
  const opcoesEmpresa = { '': 'Todos', plataforma: 'Equipe da plataforma', ...Object.fromEntries(empresas.map((e) => [e.id, e.nome])) };
  const filtro = (rotulo, nome, opcoes) => {
    const s = escolha(null, nome, opcoes, estado[nome]);
    s.addEventListener('change', () => { estado[nome] = s.value; carregar(); });
    return el('label', { class: 'campo' }, rotulo, s);
  };
  const busca = el('input', { placeholder: 'Nome ou e-mail' });
  busca.addEventListener('change', () => { estado.busca = busca.value; carregar(); });
  const formUsuario = (u) => formModal(u ? `Editar ${u.nome}` : 'Novo usuário', (f) => {
    const perfil = escolha('Perfil', 'perfil', PERFIS, u?.perfil ?? 'cliente', { required: true });
    const empresa = escolha('Empresa', 'empresa_id', Object.fromEntries(empresas.map((e) => [e.id, e.nome])), u?.empresa_id ?? empresas[0]?.id);
    const ajustar = () => { empresa.classList.toggle('oculto', ['master', 'suporte'].includes(f.querySelector('[name=perfil]').value) || Boolean(u)); };
    perfil.querySelector('select').addEventListener('change', ajustar);
    queueMicrotask(ajustar);
    return [
      campo('Nome', { name: 'nome', required: true, maxlength: 120, value: u?.nome ?? '' }),
      u ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, `${u.email}${u.empresa_nome ? ` · ${u.empresa_nome}` : ''}`) : campo('E-mail', { name: 'email', type: 'email', required: true }),
      perfil, empresa,
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Master: tudo. Suporte: empresas, rastreadores, mapa geral e diagnóstico. Administrador da empresa: o painel da empresa. Operador: acompanha a frota e trata alertas.'),
      campo(u ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial (mínimo 8)', { name: 'senha', type: 'password', minlength: 8, required: !u, autocomplete: 'new-password' }),
      u ? marcar('Usuário ativo', { name: 'ativo', checked: Boolean(u.ativo) }) : null,
    ];
  }, async (d) => {
    if (!d.senha) delete d.senha;
    if (u) {
      delete d.empresa_id;
      return api.patch(`/master/usuarios/${u.id}`, d);
    }
    return api.post('/master/usuarios', d);
  });

  async function carregar() {
    const usuarios = await api.get(`/master/usuarios${qs(estado)}`);
    limpar(lista, tabela(['Nome', 'E-mail', 'Perfil', 'Empresa', 'Último acesso', 'Situação', '^Ações'], usuarios.map((u) => el('tr', {},
      td(u.nome), td(u.email), td(PERFIS[u.perfil]), td(u.empresa_nome ?? el('span', { class: 'mudo' }, 'Plataforma')), td(dataHora(u.ultimo_acesso)),
      td(u.ativo ? etiqueta('ativo', 'ok') : etiqueta('inativo', 'erro')),
      el('td', { class: 'acoes' }, botaoIcone('editar', 'Editar', async () => { if (await formUsuario(u)) { toast('Usuário salvo.'); carregar(); } })))), 'Nenhum usuário.'));
  }
  limpar(ctx.conteudo, el('div', { class: 'filtros livre' }, filtro('Empresa', 'empresa_id', opcoesEmpresa), filtro('Perfil', 'perfil', { '': 'Todos', ...PERFIS }),
    el('label', { class: 'campo' }, 'Buscar', busca),
    el('button', { class: 'btn primario', onclick: async () => { if (await formUsuario()) { toast('Usuário criado.'); carregar(); } } }, 'Novo usuário')),
  cartao(null, lista));
  await carregar();
}

// ---------- Diagnóstico ----------
async function telaDiagnostico(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get('/master/diagnostico');
    const PROT = { ...PROTOCOLOS };
    limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:18px' },
      cartao('Verificações', tabela(['Item', 'Situação', 'Detalhe'], d.verificacoes.map((x) => el('tr', {},
        td(x.nome), td([el('span', { class: `bolinha ${situacaoDiag[x.situacao][0]}` }), situacaoDiag[x.situacao][1]]), td(x.detalhe.replace(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/, (m) => dataHora(m))))))),
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c6' }, cartao('Mensagens recebidas (7 dias)', tabela(['Dia', 'Protocolo', '>Mensagens'], d.recepcao.map((x) => el('tr', {},
          td(data(x.data)), td(PROT[x.protocolo] ?? x.protocolo), td(inteiro(x.mensagens), 'dir num'))), 'Nenhuma mensagem recebida.'))),
        el('div', { class: 'c6' }, cartao('Servidor',
          ...[['No ar desde', dataHora(d.servidor.iniciado_em)], ['Node.js', d.servidor.node], ['Memória', `${d.servidor.memoria_mb} MB`], ['Fuso', d.servidor.fuso],
            ['Posições guardadas', inteiro(d.servidor.posicoes)], ['Retenção', `${d.servidor.retencao_dias} dias`]].map(([r, v]) => linhaDado(r, v)))))));
  }, 15_000));
}

// ---------- Configurações ----------
async function telaConfiguracoes(ctx) {
  const c = await api.get('/master/configuracoes');
  const f = el('form', { class: 'form', style: 'max-width:820px' },
    el('fieldset', {}, el('legend', {}, 'Plataforma'), campo('Nome exibido no painel', { name: 'nome_plataforma', required: true, maxlength: 60, value: c.nome_plataforma })),
    el('fieldset', {}, el('legend', {}, 'Rastreamento'),
      el('div', { class: 'tres' }, campo('Online se comunicou há até (min)', { name: 'online_min', type: 'number', min: 1, value: c.online_min }),
        campo('Parada que encerra a viagem (min)', { name: 'parada_min', type: 'number', min: 1, value: c.parada_min }),
        campo('Guardar posições por (dias)', { name: 'retencao_dias', type: 'number', min: 7, value: c.retencao_dias })),
      el('div', { class: 'duas' }, campo('Descartar saltos do GPS acima de (km/h)', { name: 'velocidade_max_plausivel_kmh', type: 'number', min: 50, value: c.velocidade_max_plausivel_kmh }),
        campo('Comando sem resposta expira em (horas)', { name: 'comando_expira_horas', type: 'number', min: 1, value: c.comando_expira_horas }))),
    el('fieldset', {}, el('legend', {}, 'Padrões para empresas novas'),
      el('div', { class: 'tres' }, campo('Limite de veículos', { name: 'limite_veiculos_padrao', type: 'number', min: 0, value: c.limite_veiculos_padrao }),
        campo('Mensalidade por veículo (R$)', { name: 'mensalidade', inputmode: 'decimal', value: reaisCampo(c.mensalidade_padrao_centavos) }),
        campo('Alerta sem comunicação (min)', { name: 'sem_comunicacao_padrao_min', type: 'number', min: 0, value: c.sem_comunicacao_padrao_min }))),
    el('fieldset', {}, el('legend', {}, 'Comandos enviados aos rastreadores GT06'),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'O texto varia por fabricante (ex.: DYD,000000# e HFYD,000000# em alguns modelos). Confira no manual do equipamento.'),
      el('div', { class: 'duas' }, campo('Bloquear', { name: 'gt06_cmd_bloquear', required: true, maxlength: 60, value: c.gt06_cmd_bloquear, class: 'mono' }),
        campo('Desbloquear', { name: 'gt06_cmd_desbloquear', required: true, maxlength: 60, value: c.gt06_cmd_desbloquear, class: 'mono' })),
      el('div', { class: 'duas' }, campo('Pedir posição', { name: 'gt06_cmd_localizar', required: true, maxlength: 60, value: c.gt06_cmd_localizar, class: 'mono' }),
        campo('Reiniciar', { name: 'gt06_cmd_reiniciar', required: true, maxlength: 60, value: c.gt06_cmd_reiniciar, class: 'mono' }))),
    el('div', {}, el('button', { class: 'btn primario largo' }, 'Salvar')));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const corpo = { ...d, mensalidade_padrao_centavos: centavos(d.mensalidade) ?? 0 };
    delete corpo.mensalidade;
    const b = f.querySelector('button');
    b.disabled = true;
    api.patch('/master/configuracoes', corpo).then(() => toast('Configurações salvas.'), (err) => toast(err.message, true)).finally(() => { b.disabled = false; });
  });
  limpar(ctx.conteudo, el('section', { class: 'cartao' }, f));
}

// ---------- Integrações ----------
async function telaIntegracoes(ctx) {
  const [empresas, cfg] = await Promise.all([listaEmpresas(), configPublica()]);
  await painelIntegracoes(ctx.conteudo, {
    empresas, podeCriar: ctx.soMaster, portaGt06: cfg.gt06_porta,
    listar: () => api.get('/master/chaves'),
    criar: (d) => api.post('/master/chaves', d),
    revogar: (id) => api.del(`/master/chaves/${id}`),
  });
}

// ---------- Atividades ----------
async function telaAtividades(ctx) {
  const corpo = el('div');
  let pagina = 1;
  const NOMES = { login: 'Entrou no painel', login_falhou: 'Login recusado', senha_alterada: 'Alterou a senha', comando_criado: 'Enviou comando' };
  async function carregar() {
    const itens = await api.get(`/master/auditoria${qs({ pagina })}`);
    limpar(corpo, cartao(null, tabela(['Quando', 'Usuário', 'Empresa', 'Ação', 'Detalhes', 'IP'], itens.map((a) => el('tr', {},
      td(dataHora(a.criado_em)), td(a.usuario ?? el('span', { class: 'mudo' }, a.detalhes?.email ?? '—')), td(a.empresa ?? '—'),
      td(a.acao === 'login_falhou' ? etiqueta(NOMES[a.acao], 'erro') : NOMES[a.acao] ?? a.acao.replace(/_/g, ' ')),
      td(el('span', { class: 'pequeno mono' }, a.detalhes ? JSON.stringify(a.detalhes).slice(0, 140) : '')), td(el('span', { class: 'mono pequeno' }, a.ip ?? '')))), 'Nada registrado.'),
    el('div', { class: 'paginacao' }, el('span', { class: 'pequeno mudo' }, `Página ${pagina}`), el('div', { class: 'linha' },
      el('button', { class: 'btn pequeno', disabled: pagina <= 1, onclick: () => { pagina--; carregar(); } }, 'Anterior'),
      el('button', { class: 'btn pequeno', disabled: itens.length < 100, onclick: () => { pagina++; carregar(); } }, 'Próxima')))));
  }
  limpar(ctx.conteudo, corpo);
  await carregar();
}

export const TELAS_MASTER = {
  dashboard: telaDashboard, mapa: telaMapa, empresas: telaEmpresas, rastreadores: telaRastreadores, usuarios: telaUsuarios, diagnostico: telaDiagnostico,
  configuracoes: telaConfiguracoes, integracoes: telaIntegracoes, atividades: telaAtividades,
};
