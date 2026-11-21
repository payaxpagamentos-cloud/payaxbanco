import { api, qs } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, paginacao, abas, etq, etqDe, rotulo, dataHora, desde, dl, numero,
  carregar, formulario, confirmar, botao, toast, faixa, stat, vazio } from '../ui.js';

const ABAS = [['divergencias', 'Divergências'], ['servicos', 'Serviços'], ['equipamentos', 'Equipamentos'], ['fila', 'Fila de tarefas']];

export default async function provisionamento({ alvo, query, ir }) {
  const aba = query.aba ?? 'divergencias';
  const corpo = el('div');
  const recarregar = () => provisionamento({ alvo, query, ir });

  limpar(alvo, cabecalho({
    sobretitulo: 'Operação',
    titulo: 'Provisionamento',
    descricao: 'O contrato diz o que o assinante comprou; o equipamento diz o que ele tem. Esta tela mostra onde os dois não batem — e nada é corrigido em silêncio.',
    acoes: [pode('integracoes.editar') ? botao('Processar a fila agora', async () => {
      const r = await api.post('/provisionamento/tarefas/processar');
      toast(`${r.executadas} tarefa(s) executada(s), ${r.pendentes} na fila.`);
      recarregar();
    }, { ic: 'atualizar' }) : null],
  }), abas(ABAS, aba, (id) => ir(`#/provisionamento?aba=${id}`)), corpo);

  if (aba === 'servicos') return servicos(corpo, ir);
  if (aba === 'equipamentos') return carregar(corpo, () => Promise.all([api.get('/provisionamento/equipamentos'), api.get('/provisionamento/drivers')]),
    ([lista, drivers]) => equipamentos(lista, drivers, recarregar));
  if (aba === 'fila') return fila(corpo, recarregar);
  return carregar(corpo, () => api.get('/provisionamento/reconciliacao'), (d) => divergencias(d, ir));
}

const GRAVIDADE = { critica: ['Crítica', 'erro'], alta: ['Alta', 'aviso'], media: ['Média', 'info'], aviso: ['Aviso', 'neutra'] };
const etqGravidade = (g) => etq(GRAVIDADE[g]?.[0] ?? g, GRAVIDADE[g]?.[1] ?? 'neutra');

function divergencias(d, ir) {
  return [
    /*
     * "Nada divergente" só pode ser dito do que foi lido. Com serviço nunca lido, o honesto é dizer que
     * não se sabe — senão a tela passa a impressão de que está tudo certo sem ter conferido nada.
     */
    d.criticos
      ? faixa(`${d.criticos} serviço(s) com divergência crítica: contrato e equipamento dizem coisas diferentes sobre quem tem acesso agora.`, 'erro', 'alerta')
      : d.divergentes.length
        ? faixa(`${d.divergentes.length} serviço(s) fora do contratado, nenhum crítico.`, 'aviso', 'info')
        : d.sem_leitura === d.servicos && d.servicos
          ? faixa('Nenhum serviço foi lido do equipamento ainda: não há como dizer o que está lá. Configure o acesso de gerência em Equipamentos e use "Ler do equipamento".', 'aviso', 'alerta')
          : d.sem_leitura
            ? faixa(`Os serviços já lidos batem com o contratado, mas ${d.sem_leitura} nunca foi lido: sobre esses, o sistema não sabe.`, 'aviso', 'info')
            : d.servicos
              ? faixa('Todo serviço lido está igual ao contratado.', 'ok', 'ok')
              : faixa('Nenhum contrato provisionado ainda. Sem serviço, o bloqueio por inadimplência é só comercial.', '', 'info'),
    el('div', { class: 'stats' },
      stat({ rotulo: 'Serviços provisionados', valor: numero(d.servicos), nota: `releitura a cada ${d.reconciliacao_horas || '—'} h`, ic: 'servidor' }),
      stat({ rotulo: 'Divergentes', valor: numero(d.divergentes.length), nota: 'Contratado ≠ equipamento', notaTipo: d.divergentes.length ? 'erro' : 'ok', ic: 'alerta' }),
      stat({ rotulo: 'Críticos', valor: numero(d.criticos), nota: 'Acesso liberado ou cortado por engano', notaTipo: d.criticos ? 'erro' : 'ok', ic: 'cadeado' }),
      stat({ rotulo: 'Sem leitura', valor: numero(d.sem_leitura), nota: 'Nunca lidos do equipamento', ic: 'info', semDado: !d.sem_leitura })),
    painel('O que não bate', tabela([
      { titulo: 'Contrato', valor: (x) => el('div', {}, el('div', { class: 'forte' }, `#${x.contrato_numero} · ${x.assinante}`),
        el('div', { class: 'fraco' }, [x.login, rotulo('situacaoContrato', x.situacao_contrato)].filter(Boolean).join(' · '))) },
      { titulo: 'Divergência', valor: (x) => el('div', {}, x.divergencias.map((y) => el('div', { style: 'margin-bottom:4px' }, etqGravidade(y.gravidade), ' ', y.texto,
        y.esperado ? el('div', { class: 'fraco' }, `contratado: ${y.esperado} · equipamento: ${y.real}`) : null))) },
      { titulo: 'Última leitura', valor: (x) => (x.lido_em ? el('div', {}, dataHora(x.lido_em), el('div', { class: 'fraco' }, desde(x.lido_em))) : el('span', { class: 'fraco' }, 'nunca')) },
    ], d.divergentes, { vazioTexto: 'Nada fora do contratado.', aoClicar: (x) => ir(`#/contratos/${x.contrato_id}`) }), { semCorpo: true }),
  ];
}

function servicos(corpo, ir) {
  const filtro = { divergentes: '', pagina: 1 };
  const sel = el('select', { 'aria-label': 'Filtro' }, el('option', { value: '' }, 'Todos os serviços'), el('option', { value: '1' }, 'Só os divergentes'));
  sel.addEventListener('change', () => { filtro.divergentes = sel.value; filtro.pagina = 1; atualizar(); });
  const lista = el('div');
  corpo.append(el('div', { class: 'filtros' }, sel), lista);
  function atualizar() {
    return carregar(lista, () => api.get(`/provisionamento/servicos${qs(filtro)}`), (l) => painel(null, tabela([
      { titulo: 'Contrato', valor: (s) => el('div', {}, el('div', { class: 'forte' }, `#${s.contrato_numero} · ${s.assinante_nome}`),
        el('div', { class: 'fraco' }, [s.login, s.concentrador_nome].filter(Boolean).join(' · '))) },
      { titulo: 'Contratado', valor: (s) => el('div', {}, rotulo('situacaoServico', s.desejado.situacao ?? 'sem'),
        el('div', { class: 'fraco' }, s.desejado.perfil ?? (s.desejado.download_kbps ? `${numero(s.desejado.download_kbps / 1000)} Mbps` : '—'))) },
      { titulo: 'No equipamento', valor: (s) => (s.estado_real
        ? el('div', {}, s.estado_real.presente ? rotulo('situacaoServico', s.estado_real.situacao) : el('span', { class: 'fraco' }, 'não existe'),
          s.estado_real.conectado ? el('div', { class: 'fraco' }, `conectado · ${s.estado_real.ip_atual ?? ''}`) : null)
        : el('span', { class: 'fraco' }, 'sem leitura')) },
      { titulo: 'Situação', valor: (s) => (s.divergencias.some((d) => d.gravidade !== 'aviso')
        ? etqGravidade(s.divergencias[0].gravidade) : etq('Em dia', 'ok')) },
      { titulo: 'Lido', valor: (s) => (s.lido_em ? desde(s.lido_em) : el('span', { class: 'fraco' }, 'nunca')) },
    ], l.itens, { vazioTexto: 'Nenhum serviço provisionado.', aoClicar: (s) => ir(`#/contratos/${s.contrato_id}`),
      pagina: paginacao(l, (p) => { filtro.pagina = p; atualizar(); }) }), { semCorpo: true }));
  }
  atualizar();
}

function equipamentos(lista, drivers, recarregar) {
  const semAcesso = lista.filter((e) => !e.driver).length;
  return [
    faixa('Cada fabricante é um driver. O que um driver não sabe fazer ele declara, e o sistema recusa a ação dizendo o que falta — nenhuma tela diz "aplicado" sem ter aplicado.', '', 'info'),
    semAcesso ? faixa(`${semAcesso} equipamento(s) sem acesso de gerência configurado: o sistema ainda não fala com eles.`, 'aviso', 'alerta') : null,
    painel('Equipamentos', tabela([
      { titulo: 'Equipamento', valor: (e) => el('div', {}, el('div', { class: 'forte' }, e.nome),
        el('div', { class: 'fraco' }, [rotulo('equipamento', e.tipo), e.fabricante, e.modelo].filter(Boolean).join(' · '))) },
      { titulo: 'Driver', valor: (e) => (e.driver ? el('div', {}, e.driver_rotulo, el('div', { class: 'fraco' }, `${e.papel ?? '—'} · ${e.capacidades.join(', ')}`))
        : el('span', { class: 'fraco' }, 'Sem driver')) },
      { titulo: 'Gerência', valor: (e) => (e.host ? el('div', {}, `${e.host}${e.porta ? `:${e.porta}` : ''}`,
        el('div', { class: 'fraco' }, [e.protocolo, e.usuario, e.verificar_tls ? 'TLS conferido' : 'TLS não conferido'].filter(Boolean).join(' · '))) : el('span', { class: 'fraco' }, '—')) },
      { titulo: 'Conexão', valor: (e) => el('div', {}, etqDe('estadoEquipamento', e.estado_conexao),
        e.identificacao ? el('div', { class: 'fraco' }, `${e.identificacao.modelo} ${e.identificacao.versao}`) : null,
        e.ultimo_erro ? el('div', { class: 'fraco' }, `${e.ultimo_erro.slice(0, 90)}${e.erro_id ? ` (ID ${e.erro_id})` : ''}`) : null) },
      { titulo: 'Serviços', valor: (e) => numero(e.servicos), classe: 'num' },
      { titulo: '', valor: (e) => (pode('integracoes.editar') ? el('div', {},
        botao('Acesso', () => configurarAcesso(e, drivers, recarregar), { tipo: 'secundario pequeno' }), ' ',
        e.driver ? botao('Testar', async () => {
          const r = await api.post(`/provisionamento/equipamentos/${e.id}/testar`);
          toast(r.situacao === 'concluida' ? `${r.resultado.modelo} ${r.resultado.versao} respondeu.` : `Falhou: ${r.erro}`, r.situacao !== 'concluida');
          recarregar();
        }, { tipo: 'fantasma pequeno' }) : null) : '') },
    ], lista, { vazioTexto: 'Nenhum equipamento cadastrado. Cadastre em Rede óptica.' }), { semCorpo: true }),
  ];
}

function configurarAcesso(e, drivers, depois) {
  const porNome = new Map(drivers.map((d) => [d.nome, d]));
  const atual = porNome.get(e.driver) ?? drivers[0];
  return formulario(`Acesso de gerência · ${e.nome}`, [
    { nome: 'driver', rotulo: 'Driver', tipo: 'select', obrigatorio: true, vazio: false, valor: e.driver ?? atual?.nome,
      opcoes: drivers.map((d) => [d.nome, `${d.rotulo} · ${d.papeis.join('/')}`]), inteiro: true },
    { nome: 'papel', rotulo: 'Papel na rede', tipo: 'select', vazio: false, valor: e.papel ?? atual?.papeis[0],
      opcoes: [['concentrador', 'Concentrador (PPPoE/BRAS)'], ['olt', 'OLT'], ['acs', 'ACS (TR-069)'], ['outro', 'Outro']] },
    { nome: 'host', rotulo: 'IP ou nome de gerência', obrigatorio: true, valor: e.host ?? e.ip_gerencia, ajuda: 'Só o endereço, sem http:// nem caminho. A rede interna é o esperado aqui.' },
    { nome: 'protocolo', rotulo: 'Protocolo', tipo: 'select', vazio: false, valor: e.protocolo ?? atual?.protocolo ?? 'https',
      opcoes: [['https', 'HTTPS'], ['http', 'HTTP'], ['ssh', 'SSH'], ['telnet', 'Telnet'], ['snmp', 'SNMP']] },
    { nome: 'porta', rotulo: 'Porta', tipo: 'number', valor: e.porta ?? atual?.porta_padrao },
    { nome: 'usuario', rotulo: 'Usuário', obrigatorio: true, valor: e.usuario },
    { nome: 'senha', rotulo: e.credencial_configurada ? 'Senha (em branco mantém a atual)' : 'Senha', tipo: 'password', obrigatorio: !e.credencial_configurada,
      autocomplete: 'new-password', ajuda: 'Guardada cifrada. Nunca aparece em tela, log ou auditoria.' },
    { nome: 'verificar_tls', rotulo: 'Conferir o certificado TLS do equipamento', tipo: 'checkbox', valor: Boolean(e.verificar_tls), inteiro: true,
      ajuda: 'Deixe desligado se o equipamento usa certificado autoassinado (o caso comum em OLT e concentrador).' },
  ], {
    largo: true,
    antes: atual?.ajuda ? faixa(atual.ajuda, '', 'info') : null,
    enviar: async (d) => {
      await api.put(`/provisionamento/equipamentos/${e.id}/acesso`, { ...d, senha: d.senha || undefined, porta: d.porta || undefined });
      toast('Acesso salvo. Use "Testar" para confirmar que o sistema fala com o equipamento.');
      depois?.();
    },
  });
}

function fila(corpo, recarregar) {
  const filtro = { situacao: '', pagina: 1 };
  const sel = el('select', { 'aria-label': 'Situação' }, el('option', { value: '' }, 'Todas'),
    ...['pendente', 'concluida', 'falhou', 'sem_suporte', 'cancelada'].map((s) => el('option', { value: s }, rotulo('situacaoTarefa', s))));
  sel.addEventListener('change', () => { filtro.situacao = sel.value; filtro.pagina = 1; atualizar(); });
  const lista = el('div');
  corpo.append(el('div', { class: 'filtros' }, sel), lista);
  function atualizar() {
    return carregar(lista, () => api.get(`/provisionamento/tarefas${qs(filtro)}`), (l) => painel(null, tabela([
      { titulo: 'Tarefa', valor: (t) => el('div', {}, el('div', { class: 'forte' }, `${rotulo('acaoTarefa', t.acao)}${t.ensaio ? ' (ensaio)' : ''}`),
        el('div', { class: 'fraco' }, [t.assinante_nome ? `#${t.contrato_numero} ${t.assinante_nome}` : t.equipamento_nome, rotulo('origemAcao', t.origem), t.usuario_nome].filter(Boolean).join(' · '))) },
      { titulo: 'Pedido', valor: (t) => dataHora(t.criado_em) },
      { titulo: 'Resultado', valor: (t) => (t.erro
        ? el('div', {}, el('div', { class: 'fraco' }, t.erro.slice(0, 120)), t.erro_id ? el('div', { class: 'fraco' }, `ID ${t.erro_id}`) : null)
        : t.resultado?.mudancas?.length ? el('div', { class: 'fraco' }, t.resultado.mudancas.join(' · '))
          : t.resultado?.semMudanca ? el('span', { class: 'fraco' }, 'nada a mudar')
            : t.resultado?.modelo ? el('span', { class: 'fraco' }, `${t.resultado.modelo} ${t.resultado.versao}`) : el('span', { class: 'fraco' }, '—')) },
      { titulo: 'Tentativas', valor: (t) => el('div', {}, numero(t.tentativas), t.proxima_tentativa ? el('div', { class: 'fraco' }, `nova em ${dataHora(t.proxima_tentativa)}`) : null), classe: 'num' },
      { titulo: 'Situação', valor: (t) => etqDe('situacaoTarefa', t.situacao) },
      { titulo: '', valor: (t) => (pode('integracoes.editar') ? el('div', {},
        ['falhou', 'sem_suporte', 'cancelada'].includes(t.situacao) ? botao('Repetir', async () => { await api.post(`/provisionamento/tarefas/${t.id}/repetir`); toast('Tarefa executada de novo.'); atualizar(); }, { tipo: 'secundario pequeno' }) : null,
        t.situacao === 'pendente' ? botao('Cancelar', async () => {
          if (!(await confirmar('Cancelar a tarefa', 'A tarefa sai da fila e o equipamento não recebe este comando. O histórico fica.', 'Cancelar tarefa'))) return;
          await api.post(`/provisionamento/tarefas/${t.id}/cancelar`);
          toast('Tarefa cancelada.');
          atualizar();
        }, { tipo: 'fantasma pequeno' }) : null) : '') },
    ], l.itens, { vazioTexto: 'Nenhuma tarefa na fila.', pagina: paginacao(l, (p) => { filtro.pagina = p; atualizar(); }) }), { semCorpo: true }));
  }
  atualizar();
}

/** Bloco do serviço provisionado, usado dentro da tela do contrato. */
export function painelServico(contrato, servico, concentradores, recarregar) {
  const acao = async (caminho, corpo, mensagem) => {
    const r = await api.post(`/provisionamento/servicos/${servico.id}${caminho}`, corpo);
    const mudancas = r.tarefa?.resultado?.mudancas ?? [];
    toast(r.tarefa.situacao === 'concluida'
      ? `${mensagem}${mudancas.length ? `: ${mudancas.join(', ')}` : ' (nada a mudar)'}`
      : `Na fila: ${r.tarefa.erro ?? 'o equipamento não respondeu agora'}`, r.tarefa.situacao !== 'concluida');
    recarregar();
  };
  const graves = (servico?.divergencias ?? []).filter((d) => d.gravidade !== 'aviso');

  if (!servico) {
    return painel('Serviço no equipamento', vazio('Este contrato ainda não está provisionado.',
      'Sem serviço, o bloqueio por inadimplência é só comercial: o acesso do assinante não é cortado.',
      pode('contratos.editar') ? botao('Provisionar', () => editarServico(contrato, null, concentradores, recarregar), { ic: 'mais' }) : null));
  }
  return painel('Serviço no equipamento', el('div', {},
    graves.length ? faixa(graves.map((d) => d.texto).join(' '), graves[0].gravidade === 'critica' ? 'erro' : 'aviso', 'alerta') : null,
    dl([
      ['Concentrador', servico.concentrador?.nome ?? 'Não definido'],
      ['Acesso', `${servico.tipo_acesso.toUpperCase()}${servico.login ? ` · ${servico.login}` : ''}`],
      ['Senha', servico.senha_definida ? 'Definida (guardada cifrada)' : 'Não definida'],
      ['Contratado', servico.desejado.perfil ?? (servico.desejado.download_kbps ? `${numero(servico.desejado.download_kbps / 1000)}/${numero(servico.desejado.upload_kbps / 1000)} Mbps` : '—')],
      ['No equipamento', servico.estado_real
        ? (servico.estado_real.presente
          ? `${rotulo('situacaoServico', servico.estado_real.situacao)}${servico.estado_real.conectado ? ` · conectado em ${servico.estado_real.ip_atual ?? '—'}` : ' · sem sessão'}`
          : 'Não existe no equipamento')
        : 'Nunca lido'],
      ['Última leitura', servico.lido_em ? `${dataHora(servico.lido_em)} (${desde(servico.lido_em)})` : 'nunca'],
      servico.ip_fixo ? ['IP fixo', servico.ip_fixo] : null,
      servico.onu_serial ? ['ONU', `${servico.onu_serial}${servico.pon ? ` · PON ${servico.pon}` : ''}`] : null,
    ]),
    el('div', { class: 'form-acoes', style: 'justify-content:flex-start;flex-wrap:wrap' },
      pode('contratos.ver') ? botao('Ler do equipamento', () => acao('/ler', {}, 'Leitura feita'), { tipo: 'secundario pequeno', ic: 'atualizar' }) : null,
      pode('contratos.editar') ? botao('Ensaiar', async () => {
        const r = await api.post(`/provisionamento/servicos/${servico.id}/sincronizar?ensaio=1`);
        const m = r.tarefa?.resultado?.mudancas ?? [];
        await formulario('O que a sincronização faria', [], {
          rotuloEnviar: 'Fechar',
          antes: m.length ? el('ul', { class: 'linha-tempo' }, m.map((x) => el('li', {}, x))) : vazio('Nada a mudar.', 'O equipamento já está igual ao contratado.'),
          enviar: async () => true,
        });
      }, { tipo: 'secundario pequeno' }) : null,
      pode('contratos.editar') ? botao('Sincronizar', () => acao('/sincronizar', {}, 'Sincronizado'), { tipo: 'pequeno', ic: 'ok' }) : null,
      pode('contratos.editar') ? botao('Editar', () => editarServico(contrato, servico, concentradores, recarregar), { tipo: 'fantasma pequeno' }) : null)));
}

function editarServico(contrato, servico, concentradores, depois) {
  return formulario(servico ? 'Serviço no equipamento' : 'Provisionar o contrato', [
    { nome: 'concentrador_id', rotulo: 'Concentrador', tipo: 'select', obrigatorio: true, inteiro: true, valor: servico?.concentrador_id,
      opcoes: concentradores.map((e) => [e.id, `${e.nome}${e.driver_rotulo ? ` · ${e.driver_rotulo}` : ''}`]),
      ajuda: concentradores.length ? null : 'Nenhum equipamento com papel de concentrador: configure o acesso em Provisionamento → Equipamentos.' },
    { nome: 'tipo_acesso', rotulo: 'Tipo de acesso', tipo: 'select', vazio: false, valor: servico?.tipo_acesso ?? 'pppoe',
      opcoes: [['pppoe', 'PPPoE'], ['ipoe', 'IPoE'], ['dhcp', 'DHCP'], ['ip_fixo', 'IP fixo']] },
    { nome: 'login', rotulo: 'Login', obrigatorio: true, valor: servico?.login, ajuda: 'Único no concentrador.' },
    { nome: 'senha', rotulo: servico?.senha_definida ? 'Senha (em branco mantém a atual)' : 'Senha', tipo: 'password', autocomplete: 'new-password',
      ajuda: servico ? null : 'Em branco, o sistema gera uma senha.' },
    { nome: 'ip_fixo', rotulo: 'IP fixo', valor: servico?.ip_fixo, ajuda: 'Em branco, o endereço vem do pool do concentrador.' },
    { tipo: 'secao', rotulo: 'Fibra e equipamento do assinante' },
    { nome: 'pon', rotulo: 'PON', valor: servico?.pon },
    { nome: 'onu_serial', rotulo: 'Serial da ONU', valor: servico?.onu_serial },
    { nome: 'cpe_serial', rotulo: 'Serial do CPE', valor: servico?.cpe_serial },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', valor: servico?.observacoes, inteiro: true },
  ], {
    largo: true,
    antes: faixa('Salvar aqui não mexe no equipamento: depois de salvar, use "Sincronizar" (ou "Ensaiar" antes) para aplicar.', '', 'info'),
    enviar: async (d) => {
      await api.put(`/provisionamento/contratos/${contrato.id}/servico`, { ...d, senha: d.senha || undefined, versao: servico?.versao });
      toast('Serviço salvo.');
      depois?.();
    },
  });
}
