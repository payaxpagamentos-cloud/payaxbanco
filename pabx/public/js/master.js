/** Telas do master (equipe da plataforma). */
import { api, qs } from './api.js';
import { el, limpar, dinheiro, dataHora, inteiro, gb, barraUso, toast, campo, escolha, marcar, formModal, perguntar, confirmar, repetir, telefone,
  TIPOS_EMPRESA, PERFIS, reaisCampo, centavos } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo, cartaoUtilizacao, cartaoSimultaneas, cartaoRamais, cartaoUsoMes, cartaoRecursos,
  painelChamadas, painelRelatorios, painelIntegracoes, situacaoDiag } from './comum.js';

const listaEmpresas = () => api.get('/master/empresas');

// ---------- Dashboard ----------
async function telaDashboard(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get('/master/dashboard');
    limpar(ctx.conteudo, el('div', { class: 'grade-dash' },
      el('div', { class: 'c12' }, el('div', { class: 'grade' },
        indicador('Empresas ativas', inteiro(d.empresas.ativa ?? 0), d.empresas.bloqueada ? `${d.empresas.bloqueada} bloqueada(s)` : 'nenhuma bloqueada'),
        indicador('Chamadas agora', inteiro(d.em_curso), `pico de hoje: ${d.simultaneas.pico}`),
        indicador('Ramais online', `${inteiro(d.ramais.online)}/${inteiro(d.ramais.total)}`),
        indicador('Faturamento do mês', dinheiro(d.utilizacao.mes.gastos_centavos), `hoje: ${dinheiro(d.utilizacao.hoje.gastos_centavos)}`))),
      el('div', { class: 'c5' }, cartaoUtilizacao(d.utilizacao)),
      el('div', { class: 'c4' }, cartaoSimultaneas(d.simultaneas, d.em_curso)),
      el('div', { class: 'c3' }, cartaoRamais(d.ramais)),
      el('div', { class: 'c5' }, cartaoUsoMes(d.uso_mes)),
      el('div', { class: 'c7' }, cartao('Empresas com mais chamadas hoje', tabela(['Empresa', '>Chamadas', '>Agora', '>Valor'], d.top_empresas.map((e) =>
        el('tr', { class: 'clicavel', onclick: () => ctx.ir('dashboard', e.id) }, td(e.nome), td(inteiro(e.chamadas), 'dir num'), td(inteiro(e.em_curso), 'dir num'),
          td(dinheiro(e.custo_centavos), 'dir num'))), 'Nenhuma chamada hoje.'))),
      el('div', { class: 'c12' }, cartaoRecursos(d.recursos))));
  }, 10_000));
}

// ---------- Empresas ----------
async function formEmpresa(atual) {
  const [troncos, cfg] = await Promise.all([api.get('/master/troncos'), atual ? null : api.get('/master/configuracoes').catch(() => null)]);
  const e = atual ?? {
    tipo: 'pabx', limite_ramais: cfg?.limite_ramais_padrao ?? 10, limite_canais: cfg?.limite_canais_padrao ?? 10, disco_mb: cfg?.disco_mb_padrao ?? 1024,
    tts_limite: 0, stt_limite: 0, tarifa_fixo_centavos: cfg?.tarifa_fixo_centavos ?? 0, tarifa_movel_centavos: cfg?.tarifa_movel_centavos ?? 0,
    tarifa_internacional_centavos: cfg?.tarifa_internacional_centavos ?? 0, gravar_chamadas: 1, tronco_id: troncos.find((t) => t.ativo)?.id ?? '',
  };
  return formModal(atual ? `Editar ${atual.nome}` : 'Nova empresa', () => [
    el('fieldset', {}, el('legend', {}, 'Empresa'),
      campo('Nome', { name: 'nome', required: true, maxlength: 160, value: e.nome ?? '' }),
      el('div', { class: 'duas' }, campo('CNPJ ou CPF', { name: 'documento', value: e.documento ?? '', inputmode: 'numeric' }), escolha('Tipo', 'tipo', TIPOS_EMPRESA, e.tipo)),
      el('div', { class: 'duas' }, campo('E-mail', { name: 'email', type: 'email', value: e.email ?? '' }), campo('Telefone', { name: 'telefone', type: 'tel', value: e.telefone ?? '' }))),
    el('fieldset', {}, el('legend', {}, 'Limites'),
      el('div', { class: 'tres' }, campo('Ramais', { name: 'limite_ramais', type: 'number', min: 0, required: true, value: e.limite_ramais }),
        campo('Chamadas simultâneas', { name: 'limite_canais', type: 'number', min: 0, required: true, value: e.limite_canais }),
        campo('Disco das gravações (MB)', { name: 'disco_mb', type: 'number', min: 0, required: true, value: e.disco_mb })),
      el('div', { class: 'duas' }, campo('TTS por mês', { name: 'tts_limite', type: 'number', min: 0, value: e.tts_limite }),
        campo('STT por mês', { name: 'stt_limite', type: 'number', min: 0, value: e.stt_limite })),
      marcar('Gravar as chamadas', { name: 'gravar_chamadas', checked: Boolean(e.gravar_chamadas) })),
    el('fieldset', {}, el('legend', {}, 'Terminação e tarifas (por minuto)'),
      escolha('Rota de saída', 'tronco_id', { '': 'Sem rota', ...Object.fromEntries(troncos.map((t) => [t.id, `${t.nome}${t.ativo ? '' : ' (inativa)'}`])) }, e.tronco_id),
      el('div', { class: 'tres' }, campo('Fixo (R$)', { name: 'tarifa_fixo', inputmode: 'decimal', value: reaisCampo(e.tarifa_fixo_centavos) }),
        campo('Móvel (R$)', { name: 'tarifa_movel', inputmode: 'decimal', value: reaisCampo(e.tarifa_movel_centavos) }),
        campo('Internacional (R$)', { name: 'tarifa_internacional', inputmode: 'decimal', value: reaisCampo(e.tarifa_internacional_centavos) }))),
    atual ? null : el('fieldset', {}, el('legend', {}, 'Primeiro administrador da empresa (opcional)'),
      el('div', { class: 'duas' }, campo('Nome', { name: 'adm_nome', maxlength: 120 }), campo('E-mail', { name: 'adm_email', type: 'email' })),
      campo('Senha inicial (mínimo 8)', { name: 'adm_senha', type: 'password', minlength: 8, autocomplete: 'new-password' })),
  ], async (d) => {
    const corpo = {
      nome: d.nome, documento: d.documento, tipo: d.tipo, email: d.email, telefone: d.telefone, limite_ramais: d.limite_ramais, limite_canais: d.limite_canais,
      disco_mb: d.disco_mb, tts_limite: d.tts_limite || 0, stt_limite: d.stt_limite || 0, gravar_chamadas: d.gravar_chamadas, tronco_id: d.tronco_id || null,
      tarifa_fixo_centavos: centavos(d.tarifa_fixo) ?? 0, tarifa_movel_centavos: centavos(d.tarifa_movel) ?? 0, tarifa_internacional_centavos: centavos(d.tarifa_internacional) ?? 0,
    };
    if (atual) return api.put(`/master/empresas/${atual.id}`, corpo);
    if (d.adm_email) corpo.administrador = { nome: d.adm_nome, email: d.adm_email, senha: d.adm_senha };
    return api.post('/master/empresas', corpo);
  }, { largo: true, rotulo: atual ? 'Salvar' : 'Criar empresa' });
}

async function telaEmpresas(ctx) {
  const estado = { busca: '', tipo: '', status: '' };
  const lista = el('div');
  const busca = el('input', { placeholder: 'Empresa...', value: estado.busca });
  const tipo = escolha(null, 'tipo', { '': 'Tipo', ...TIPOS_EMPRESA }, '');
  const status = escolha(null, 'status', { '': 'Status', ativa: 'Ativa', bloqueada: 'Bloqueada' }, '');
  const filtrar = () => { Object.assign(estado, { busca: busca.value, tipo: tipo.value, status: status.value }); carregar(); };
  busca.addEventListener('keydown', (e) => { if (e.key === 'Enter') filtrar(); });

  async function carregar() {
    const empresas = await api.get(`/master/empresas${qs(estado)}`);
    limpar(lista, tabela(['Empresas', '^Tipo', '^Ramais', '^Chamadas Online / Total', '^Uso do Disco', '^Configurações'], empresas.map((e) => el('tr', { class: 'clicavel', onclick: () => {
      ctx.renomearEmpresa(e.id, e.nome);
      ctx.ir('dashboard', e.id);
    } },
      td([e.nome, e.status === 'bloqueada' ? el('div', {}, el('span', { class: 'etiqueta erro', title: e.motivo_bloqueio ?? '' }, 'bloqueada')) : null]),
      td(TIPOS_EMPRESA[e.tipo], 'centro'), td(`${e.ramais}/${e.limite_ramais}`, 'centro num'), td(`${e.chamadas_online} / ${e.chamadas_hoje}`, 'centro num'),
      el('td', { style: 'width:170px' }, barraUso(e.disco_bytes, e.disco_mb * 1048576, { formato: (b) => gb(b).replace('GB', ''), sufixo: 'GB' })),
      el('td', { class: 'acoes' },
        botaoIcone('editar', 'Editar', async () => { if (await formEmpresa(await api.get(`/master/empresas/${e.id}`))) { toast('Empresa salva.'); carregar(); } }),
        e.status === 'bloqueada'
          ? botaoIcone('aberto', 'Desbloquear', async () => {
            if (!await confirmar('Desbloquear empresa', `${e.nome} volta a fazer e receber chamadas e os usuários voltam a entrar.`, 'Desbloquear')) return;
            await api.post(`/master/empresas/${e.id}/desbloquear`);
            toast('Empresa desbloqueada.');
            carregar();
          })
          : botaoIcone('cadeado', 'Bloquear', async () => {
            const motivo = await perguntar(`Bloquear ${e.nome}`, 'Motivo (os usuários da empresa não entram e as chamadas novas são recusadas)');
            if (!motivo) return;
            await api.post(`/master/empresas/${e.id}/bloquear`, { motivo });
            toast('Empresa bloqueada.');
            carregar();
          }),
        ctx.soMaster ? botaoIcone('lixo', 'Excluir', async () => {
          const nome = await perguntar(`Excluir ${e.nome}`, 'Digite o nome da empresa para confirmar. Usuários, chaves e ramais são desativados e os números voltam ao estoque; o histórico de chamadas fica guardado.');
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

// ---------- Chamadas ----------
async function telaChamadas(ctx) {
  const empresas = await listaEmpresas();
  await painelChamadas(ctx.conteudo, '/master/chamadas', { master: true, empresas });
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
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Master: tudo. Suporte: empresas, chamadas, relatórios, terminação (consulta) e diagnóstico. Administrador da empresa: o painel da empresa. Supervisor: só consulta o painel da empresa.'),
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
      td(u.ativo ? el('span', { class: 'etiqueta ok' }, 'ativo') : el('span', { class: 'etiqueta erro' }, 'inativo')),
      el('td', { class: 'acoes' }, botaoIcone('editar', 'Editar', async () => { if (await formUsuario(u)) { toast('Usuário salvo.'); carregar(); } })))), 'Nenhum usuário.'));
  }
  limpar(ctx.conteudo, el('div', { class: 'filtros livre' }, filtro('Empresa', 'empresa_id', opcoesEmpresa), filtro('Perfil', 'perfil', { '': 'Todos', ...PERFIS }),
    el('label', { class: 'campo' }, 'Buscar', busca),
    el('button', { class: 'btn primario', onclick: async () => { if (await formUsuario()) { toast('Usuário criado.'); carregar(); } } }, 'Novo usuário')),
  cartao(null, lista));
  await carregar();
}

// ---------- Segurança ----------
async function telaSeguranca(ctx) {
  const corpo = el('div', { class: 'coluna' });
  const auditoria = el('div');
  let pagina = 1;
  const NOMES = { login: 'Entrou no painel', login_falhou: 'Login recusado', senha_alterada: 'Alterou a senha' };
  async function carregarAuditoria() {
    const itens = await api.get(`/master/seguranca/auditoria${qs({ pagina })}`);
    limpar(auditoria, tabela(['Quando', 'Usuário', 'Empresa', 'Ação', 'Detalhes', 'IP'], itens.map((a) => el('tr', {},
      td(dataHora(a.criado_em)), td(a.usuario ?? el('span', { class: 'mudo' }, a.detalhes?.email ?? '—')), td(a.empresa ?? '—'),
      td(a.acao === 'login_falhou' ? el('span', { class: 'etiqueta erro' }, NOMES[a.acao]) : NOMES[a.acao] ?? a.acao.replace(/_/g, ' ')),
      td(el('span', { class: 'pequeno mono' }, a.detalhes ? JSON.stringify(a.detalhes).slice(0, 120) : '')), td(el('span', { class: 'mono pequeno' }, a.ip ?? '')))), 'Nada registrado.'),
    el('div', { class: 'paginacao' }, el('span', { class: 'pequeno mudo' }, `Página ${pagina}`), el('div', { class: 'linha' },
      el('button', { class: 'btn pequeno', disabled: pagina <= 1, onclick: () => { pagina--; carregarAuditoria(); } }, 'Anterior'),
      el('button', { class: 'btn pequeno', disabled: itens.length < 100, onclick: () => { pagina++; carregarAuditoria(); } }, 'Próxima'))));
  }
  async function carregar() {
    const r = await api.get('/master/seguranca/resumo');
    const bloquear = async (ip) => {
      const motivo = await perguntar(`Bloquear ${ip ?? 'endereço IP'}`, ip ? 'Motivo' : 'Endereço IP', { obrigatorio: !ip });
      if (motivo === null) return;
      await api.post('/master/seguranca/ips', ip ? { ip, motivo } : { ip: motivo });
      toast('IP bloqueado.');
      carregar();
    };
    limpar(corpo,
      el('div', { class: 'grade' }, indicador('Logins recusados (24 h)', inteiro(r.falhas_login.reduce((s, x) => s + x.tentativas, 0)), `${r.falhas_login.length} endereço(s)`),
        indicador('IPs bloqueados', inteiro(r.ips_bloqueados.length)), indicador('Chaves de API ativas', inteiro(r.chaves_ativas)), indicador('Masters ativos', inteiro(r.masters))),
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c6' }, cartao('Logins recusados nas últimas 24 h', tabela(['IP', '>Tentativas', 'Última', '^'], r.falhas_login.map((x) => el('tr', {},
          td(el('span', { class: 'mono' }, x.ip ?? '—')), td(inteiro(x.tentativas), 'dir num'), td(dataHora(x.ultima)),
          el('td', { class: 'acoes' }, x.ip && !r.ips_bloqueados.some((b) => b.ip === x.ip) ? botao('Bloquear', 'perigo', () => bloquear(x.ip)) : null))), 'Nenhuma tentativa recusada.'))),
        el('div', { class: 'c6' }, cartao('IPs bloqueados', tabela(['IP', 'Motivo', 'Desde', '^'], r.ips_bloqueados.map((b) => el('tr', {},
          td(el('span', { class: 'mono' }, b.ip)), td(b.motivo ?? '—'), td(dataHora(b.criado_em)),
          el('td', { class: 'acoes' }, botao('Liberar', '', async () => { await api.del(`/master/seguranca/ips/${encodeURIComponent(b.ip)}`); toast('IP liberado.'); carregar(); })))),
          'Nenhum IP bloqueado.'), el('div', { style: 'margin-top:12px' }, botao('Bloquear um IP', '', () => bloquear(null)))))),
      cartao('Registro de atividades', auditoria));
    await carregarAuditoria();
  }
  limpar(ctx.conteudo, corpo);
  await carregar();
}

// ---------- Relatórios ----------
async function telaRelatorios(ctx) {
  await painelRelatorios(ctx.conteudo, '/master/relatorios', { master: true });
}

// ---------- Terminação: rotas e números ----------
async function telaTerminacao(ctx) {
  const corpo = el('div', { class: 'coluna' });
  limpar(ctx.conteudo, corpo);
  const formTronco = (t) => formModal(t ? `Editar ${t.nome}` : 'Nova rota de saída', () => [
    campo('Nome', { name: 'nome', required: true, maxlength: 80, value: t?.nome ?? '' }),
    el('div', { class: 'duas' }, campo('Endereço (host) da operadora', { name: 'host', required: true, value: t?.host ?? '' }), campo('Porta', { name: 'porta', type: 'number', value: t?.porta ?? 5060 })),
    el('div', { class: 'duas' }, campo('Usuário', { name: 'usuario', value: t?.usuario ?? '', autocomplete: 'off' }),
      campo(t?.tem_senha ? 'Senha (em branco mantém a atual)' : 'Senha', { name: 'senha', type: 'password', autocomplete: 'new-password' })),
    el('div', { class: 'duas' }, campo('Prefixo de discagem', { name: 'prefixo', value: t?.prefixo ?? '', inputmode: 'numeric' }), campo('Canais', { name: 'canais', type: 'number', min: 1, value: t?.canais ?? 30 })),
    el('fieldset', {}, el('legend', {}, 'Custo da operadora por minuto (R$)'), el('div', { class: 'tres' },
      campo('Fixo', { name: 'custo_fixo', inputmode: 'decimal', value: reaisCampo(t?.custo_fixo_centavos ?? 0) }),
      campo('Móvel', { name: 'custo_movel', inputmode: 'decimal', value: reaisCampo(t?.custo_movel_centavos ?? 0) }),
      campo('Internacional', { name: 'custo_internacional', inputmode: 'decimal', value: reaisCampo(t?.custo_internacional_centavos ?? 0) }))),
    marcar('Rota ativa', { name: 'ativo', checked: t ? Boolean(t.ativo) : true }),
  ], (d) => {
    const corpo2 = { nome: d.nome, host: d.host, porta: d.porta, usuario: d.usuario, senha: d.senha || undefined, prefixo: d.prefixo, canais: d.canais, ativo: d.ativo,
      custo_fixo_centavos: centavos(d.custo_fixo) ?? 0, custo_movel_centavos: centavos(d.custo_movel) ?? 0, custo_internacional_centavos: centavos(d.custo_internacional) ?? 0 };
    return t ? api.put(`/master/troncos/${t.id}`, corpo2) : api.post('/master/troncos', corpo2);
  });

  async function carregar() {
    const [troncos, numeros, empresas] = await Promise.all([api.get('/master/troncos'), api.get('/master/numeros'), listaEmpresas()]);
    const nomesEmp = Object.fromEntries(empresas.map((e) => [e.id, e.nome]));
    const formNumeros = () => formModal('Adicionar números', () => [
      el('label', { class: 'campo' }, 'Números (um por linha, com DDD)', el('textarea', { name: 'numeros', required: true, placeholder: '1130000000\n1130000001' })),
      campo('Descrição', { name: 'descricao', maxlength: 120 }),
      escolha('Rota de entrada', 'tronco_id', { '': 'Nenhuma', ...Object.fromEntries(troncos.map((t) => [t.id, t.nome])) }, troncos[0]?.id ?? ''),
      escolha('Empresa', 'empresa_id', { '': 'Deixar no estoque', ...nomesEmp }, ''),
    ], async (d) => {
      const r = await api.post('/master/numeros', d);
      toast(`${r.criados} número(s) adicionado(s)${r.repetidos ? `, ${r.repetidos} já existia(m)` : ''}.`);
      return r;
    });
    const formNumero = (n) => formModal(`Número ${telefone(n.numero)}`, () => [
      escolha('Empresa', 'empresa_id', { '': 'Estoque (sem empresa)', ...nomesEmp }, n.empresa_id ?? ''),
      escolha('Rota de entrada', 'tronco_id', { '': 'Nenhuma', ...Object.fromEntries(troncos.map((t) => [t.id, t.nome])) }, n.tronco_id ?? ''),
      campo('Descrição', { name: 'descricao', value: n.descricao ?? '', maxlength: 120 }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Trocar a empresa apaga o destino configurado; a nova empresa escolhe para onde as chamadas vão.'),
    ], (d) => api.patch(`/master/numeros/${n.id}`, { empresa_id: d.empresa_id || null, tronco_id: d.tronco_id || null, descricao: d.descricao }));

    limpar(corpo,
      cartao('Rotas de saída (operadoras)', tabela(['Nome', 'Endereço', '^Canais', '^Agora', '^Hoje', '^Empresas', '>Custo fixo/móvel/intern.', 'Situação', '^Ações'], troncos.map((t) => el('tr', {},
        td(t.nome), td(el('span', { class: 'mono pequeno' }, `${t.usuario ? `${t.usuario}@` : ''}${t.host}:${t.porta}`)), td(t.canais, 'centro num'), td(t.em_curso, 'centro num'),
        td(t.chamadas_hoje, 'centro num'), td(t.empresas, 'centro num'),
        td(`${dinheiro(t.custo_fixo_centavos)} / ${dinheiro(t.custo_movel_centavos)} / ${dinheiro(t.custo_internacional_centavos)}`, 'dir num'),
        td(t.ativo ? el('span', { class: 'etiqueta ok' }, 'ativa') : el('span', { class: 'etiqueta erro' }, 'inativa')),
        el('td', { class: 'acoes' }, ctx.soMaster ? [
          botaoIcone('editar', 'Editar', async () => { if (await formTronco(t)) { toast('Rota salva.'); carregar(); } }),
          botaoIcone('lixo', 'Excluir', async () => {
            if (!await confirmar('Excluir rota', `Excluir a rota ${t.nome}?`, 'Excluir')) return;
            await api.del(`/master/troncos/${t.id}`);
            toast('Rota excluída.');
            carregar();
          }, 'perigo')] : null))), 'Nenhuma rota cadastrada. Cadastre a operadora que faz as ligações para fora.'),
      ctx.soMaster ? el('div', { style: 'margin-top:12px' }, botao('Nova rota', 'primario', async () => { if (await formTronco()) { toast('Rota criada.'); carregar(); } })) : null),
      cartao('Números (DIDs)', tabela(['Número', 'Descrição', 'Rota', 'Empresa', 'Destino', '^Ações'], numeros.map((n) => el('tr', {},
        td(telefone(n.numero), 'num'), td(n.descricao ?? '—'), td(n.tronco ?? '—'), td(n.empresa ?? el('span', { class: 'etiqueta' }, 'estoque')),
        td(n.empresa ? (n.destino_tipo ? el('span', { class: 'etiqueta ok' }, n.destino_tipo) : el('span', { class: 'etiqueta aviso' }, 'sem destino')) : '—'),
        el('td', { class: 'acoes' }, ctx.soMaster ? [
          botaoIcone('editar', 'Editar', async () => { if (await formNumero(n)) { toast('Número salvo.'); carregar(); } }),
          botaoIcone('lixo', 'Excluir', async () => {
            if (!await confirmar('Excluir número', `Excluir ${telefone(n.numero)}?`, 'Excluir')) return;
            await api.del(`/master/numeros/${n.id}`);
            toast('Número excluído.');
            carregar();
          }, 'perigo')] : null))), 'Nenhum número cadastrado.'),
      ctx.soMaster ? el('div', { style: 'margin-top:12px' }, botao('Adicionar números', 'primario', async () => { if (await formNumeros()) carregar(); })) : null));
  }
  await carregar();
}

// ---------- Diagnóstico ----------
async function telaDiagnostico(ctx) {
  ctx.parar(repetir(async () => {
    const d = await api.get('/master/diagnostico');
    limpar(ctx.conteudo, el('div', { class: 'coluna' },
      cartao('Verificações', tabela(['Item', 'Situação', 'Detalhe'], d.verificacoes.map((x) => el('tr', {},
        td(x.nome), td([el('span', { class: `bolinha ${situacaoDiag[x.situacao][0]}` }), situacaoDiag[x.situacao][1]]), td(x.detalhe.replace(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/, (m) => dataHora(m)))))))),
      el('div', { class: 'grade-dash' },
        el('div', { class: 'c6' }, cartao('Rotas de saída', tabela(['Rota', '^Agora / canais', 'Última chamada', 'Situação'], d.troncos.map((t) => el('tr', {},
          td(t.nome), td(`${t.em_curso} / ${t.canais}`, 'centro num'), td(dataHora(t.ultima_chamada)),
          td(t.ativo ? el('span', { class: 'etiqueta ok' }, 'ativa') : el('span', { class: 'etiqueta erro' }, 'inativa')))), 'Nenhuma rota cadastrada.'))),
        el('div', { class: 'c6' }, cartao('Servidor do painel',
          ...[['No ar desde', dataHora(d.servidor.iniciado_em)], ['Node.js', d.servidor.node], ['Memória', `${d.servidor.memoria_mb} MB`], ['Fuso', d.servidor.fuso],
            ['Última chamada registrada', dataHora(d.servidor.ultima_chamada)]].map(([r, v]) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, r), el('strong', {}, v)))))));
  }, 15_000));
}

// ---------- Configurações ----------
async function telaConfiguracoes(ctx) {
  const c = await api.get('/master/configuracoes');
  const f = el('form', { class: 'form', style: 'max-width:760px' },
    el('fieldset', {}, el('legend', {}, 'Plataforma'), campo('Nome exibido no painel', { name: 'nome_plataforma', required: true, maxlength: 60, value: c.nome_plataforma })),
    el('fieldset', {}, el('legend', {}, 'Tarifação'),
      el('div', { class: 'duas' }, campo('Cobrança mínima (segundos)', { name: 'cadencia_inicial_s', type: 'number', min: 1, value: c.cadencia_inicial_s }),
        campo('Depois, em blocos de (segundos)', { name: 'cadencia_s', type: 'number', min: 1, value: c.cadencia_s })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, `Ex.: ${c.cadencia_inicial_s}/${c.cadencia_s} cobra ${c.cadencia_inicial_s} s no mínimo e depois a cada ${c.cadencia_s} s. Só as ligações realizadas e atendidas são cobradas.`)),
    el('fieldset', {}, el('legend', {}, 'Padrões para empresas novas'),
      el('div', { class: 'tres' }, campo('Tarifa fixo (R$/min)', { name: 'tarifa_fixo', inputmode: 'decimal', value: reaisCampo(c.tarifa_fixo_centavos) }),
        campo('Tarifa móvel (R$/min)', { name: 'tarifa_movel', inputmode: 'decimal', value: reaisCampo(c.tarifa_movel_centavos) }),
        campo('Tarifa internacional (R$/min)', { name: 'tarifa_internacional', inputmode: 'decimal', value: reaisCampo(c.tarifa_internacional_centavos) })),
      el('div', { class: 'tres' }, campo('Ramais', { name: 'limite_ramais_padrao', type: 'number', min: 0, value: c.limite_ramais_padrao }),
        campo('Chamadas simultâneas', { name: 'limite_canais_padrao', type: 'number', min: 0, value: c.limite_canais_padrao }),
        campo('Disco (MB)', { name: 'disco_mb_padrao', type: 'number', min: 0, value: c.disco_mb_padrao }))),
    el('fieldset', {}, el('legend', {}, 'Central telefônica'),
      el('div', { class: 'duas' }, campo('Encerrar chamadas presas após (horas)', { name: 'chamada_max_horas', type: 'number', min: 1, max: 48, value: c.chamada_max_horas }),
        campo('Ramal offline sem registro há (minutos)', { name: 'registro_expira_min', type: 'number', min: 1, value: c.registro_expira_min }))),
    el('div', {}, el('button', { class: 'btn primario largo' }, 'Salvar')));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const corpo = { ...d, tarifa_fixo_centavos: centavos(d.tarifa_fixo), tarifa_movel_centavos: centavos(d.tarifa_movel), tarifa_internacional_centavos: centavos(d.tarifa_internacional) };
    delete corpo.tarifa_fixo; delete corpo.tarifa_movel; delete corpo.tarifa_internacional;
    const b = f.querySelector('button');
    b.disabled = true;
    api.patch('/master/configuracoes', corpo).then(() => toast('Configurações salvas.'), (err) => toast(err.message, true)).finally(() => { b.disabled = false; });
  });
  limpar(ctx.conteudo, el('section', { class: 'cartao' }, f));
}

// ---------- Integrações ----------
async function telaIntegracoes(ctx) {
  const empresas = await listaEmpresas();
  await painelIntegracoes(ctx.conteudo, {
    empresas, podeCriar: ctx.soMaster,
    listar: () => api.get('/master/chaves'),
    criar: (d) => api.post('/master/chaves', d),
    revogar: (id) => api.del(`/master/chaves/${id}`),
  });
}

export const TELAS_MASTER = {
  dashboard: telaDashboard, empresas: telaEmpresas, chamadas: telaChamadas, usuarios: telaUsuarios, seguranca: telaSeguranca, relatorios: telaRelatorios,
  terminacao: telaTerminacao, diagnostico: telaDiagnostico, configuracoes: telaConfiguracoes, integracoes: telaIntegracoes,
};
