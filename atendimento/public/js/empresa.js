/** Telas do painel da empresa. */
import {api, qs} from './api.js';
import {
  el, limpar, icone, toast, confirmar, formModal, modal, campo, area, escolha, marcar, inteiro, porcento,
  duracao, dataHora, desde, espera, diasSemana, telefone as formatarTelefone, etiquetaChamado, PERFIS, repetir,
  iniciais,
} from './ui.js';
import {
  cartao, indicador, tabela, td, botaoIcone, acoesTopo, vazio, campoBusca, seletor, indicadoresAtendimento,
  cartaoDesfechos, cartaoTempos, cartaoCustoIa, telaRelatorios,
} from './comum.js';
import {telaCaixa} from './caixa.js';
import {telaIa} from './ia.js';
import {telaOuvidoria} from './ouvidoria.js';

// ---------- Dashboard ----------

async function dashboard(ctx) {
  const conteudo = el('div');
  const desenhar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/painel`);
    const a = d.agora;
    limpar(conteudo,
      el('div', { class: 'indicadores' },
        indicador('Com a ZOE', inteiro(a.com_ia), 'ela está conduzindo agora', 'robo', 'verde'),
        indicador('Esperando na fila', inteiro(a.aguardando), a.aguardando ? 'alguém precisa assumir' : 'ninguém esperando', 'relogio', a.aguardando ? 'vermelho' : 'azul'),
        indicador('Com a equipe', inteiro(a.com_humano), `${inteiro(a.atendentes_disponiveis)} de ${inteiro(a.atendentes)} atendente(s) disponível(is)`, 'pessoa', 'azul'),
        indicador('Chamados abertos', inteiro(Number(d.chamados.abertos ?? 0) + Number(d.chamados.andamento ?? 0)), `${inteiro(d.chamados.abertos ?? 0)} aguardando`, 'chamados', 'laranja')),

      d.filas.some((f) => f.aguardando) ? cartao('Filas agora',
        tabela(['Fila', '^Esperando', '>Espera da mais antiga'], d.filas.filter((f) => f.aguardando).map((f) => el('tr', { class: 'clicavel', onclick: () => ctx.ir('caixa') },
          td(f.nome), td(inteiro(f.aguardando), 'centro num'), td(espera(f.espera_s), 'dir'))))) : null,

      el('div', { class: 'grade-2' },
        cartao('Hoje', el('div', { class: 'indicadores embutidos' }, indicadoresAtendimento(d.hoje))),
        cartaoTempos(d.hoje)),
      el('div', { class: 'grade-2' }, cartaoDesfechos(d.mes), cartaoCustoIa(d.mes.ia)),
      cartao('No mês',
        el('p', { class: 'mudo', style: 'margin:0 0 10px' },
          `${inteiro(d.mes.conversas)} conversa(s) no mês. A ZOE resolveu ${porcento(d.mes.taxa_resolucao_ia)} sozinha`
          + `${d.mes.csat_medio === null ? '' : `, com satisfação média de ${d.mes.csat_medio.toLocaleString('pt-BR')} de 5`}.`),
        el('div', { class: 'indicadores embutidos' }, indicadoresAtendimento(d.mes))));
  };
  limpar(ctx.conteudo, conteudo);
  await desenhar();
  ctx.parar(repetir(desenhar, 15_000));
}

// ---------- Filas ----------

async function filas(ctx) {
  const lista = el('div');
  const equipe = (await api.get(`/empresas/${ctx.empresaId}/usuarios`)).itens.filter((u) => u.ativo && ['atendente', 'cliente'].includes(u.perfil));

  const recarregar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/filas`);
    limpar(lista, cartao(null, tabela(['Fila', 'Quando a IA usa', 'Horário', 'Atendentes', '^Esperando', '^Ativa', ''],
      d.itens.map((f) => el('tr', {},
        td(el('div', {}, el('strong', {}, f.nome), f.descricao ? el('div', { class: 'pequeno mudo' }, f.descricao) : null)),
        td(el('span', { class: 'pequeno' }, f.quando_usar ?? '—')),
        td(el('div', {}, diasSemana(f.dias), el('div', { class: 'pequeno mudo' }, `${f.abre} às ${f.fecha}`),
          el('div', { class: `pequeno ${f.dentro_horario ? 'ok-texto' : 'mudo'}` }, f.dentro_horario ? 'aberta agora' : 'fechada agora'))),
        td(f.atendentes.length
          ? el('div', { class: 'linha', style: 'gap:4px;flex-wrap:wrap' }, f.atendentes.map((u) => el('span', { class: `etiqueta ${u.disponivel ? 'ok' : ''}`, title: u.disponivel ? 'disponível' : 'indisponível' }, u.nome.split(' ')[0])))
          : el('span', { class: 'etiqueta erro' }, 'ninguém')),
        td(inteiro(f.aguardando), 'centro num'),
        td(f.ativa ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'),
        td(ctx.soAdmin ? el('div', { class: 'linha', style: 'gap:4px' },
          botaoIcone('equipe', 'Quem atende', () => escolherAtendentes(f)),
          botaoIcone('editar', 'Editar', () => editar(f)),
          botaoIcone('lixo', 'Excluir', () => excluir(f), 'perigo')) : null, 'dir'))),
    'Nenhuma fila. Sem fila, a ZOE não tem para onde transferir.')));
  };

  const form = (f = {}) => [
    campo('Nome', { name: 'nome', value: f.nome ?? '', required: true, maxlength: 60, placeholder: 'Financeiro' }),
    campo('Descrição', { name: 'descricao', value: f.descricao ?? '', maxlength: 300 }),
    area('Quando a ZOE deve mandar para cá', { name: 'quando_usar', rows: 3, maxlength: 500, placeholder: 'boleto, fatura, pagamento, cobrança, atraso, negociação' }, f.quando_usar ?? ''),
    el('p', { class: 'mudo pequeno', style: 'margin:0' }, 'Este texto entra no prompt da IA: é assim que ela escolhe a fila certa.'),
    el('div', { class: 'grade-2' },
      campo('Abre', { name: 'abre', type: 'time', value: f.abre ?? '08:00', required: true }),
      campo('Fecha', { name: 'fecha', type: 'time', value: f.fecha ?? '18:00', required: true })),
    el('label', { class: 'campo' }, 'Dias de atendimento',
      el('div', { class: 'escolha-dias' }, ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'].map((dia, i) =>
        el('label', { class: 'marcar' }, el('input', { type: 'checkbox', name: `dia${i}`, checked: (f.dias ?? '0111110')[i] === '1' }), dia.slice(0, 3))))),
    campo('Ordem', { name: 'ordem', type: 'number', value: f.ordem ?? 0, min: 0, max: 999 }),
    marcar('Ativa', { name: 'ativa', checked: f.id ? Boolean(f.ativa) : true }),
  ];

  const comDias = (d) => ({ ...d, dias: [0, 1, 2, 3, 4, 5, 6].map((i) => (d[`dia${i}`] ? '1' : '0')).join('') });

  const criar = () => formModal('Nova fila', () => form(), async (d) => {
    await api.post(`/empresas/${ctx.empresaId}/filas`, comDias(d));
    toast('Fila criada.');
    await recarregar();
  }, { largo: true });

  const editar = (f) => formModal(`Editar ${f.nome}`, () => form(f), async (d) => {
    await api.patch(`/empresas/${ctx.empresaId}/filas/${f.id}`, comDias(d));
    toast('Fila salva.');
    await recarregar();
  }, { largo: true });

  const excluir = async (f) => {
    if (!await confirmar('Excluir fila', `"${f.nome}" será removida. Conversas em aberto nela impedem a exclusão.`, 'Excluir')) return;
    await api.del(`/empresas/${ctx.empresaId}/filas/${f.id}`);
    toast('Fila excluída.');
    await recarregar();
  };

  const escolherAtendentes = (f) => formModal(`Quem atende ${f.nome}`, () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' }, 'Só quem está nesta lista e marcado como disponível recebe conversa desta fila.'),
    ...equipe.map((u) => marcar(`${u.nome} — ${PERFIS[u.perfil]}`, { name: `u${u.id}`, checked: f.atendentes.some((x) => x.id === u.id) })),
  ], async (d) => {
    await api.put(`/empresas/${ctx.empresaId}/filas/${f.id}/atendentes`, { atendentes: equipe.filter((u) => d[`u${u.id}`]).map((u) => u.id) });
    toast('Equipe da fila salva.');
    await recarregar();
  });

  limpar(ctx.conteudo, acoesTopo(el('span'), ctx.soAdmin ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova fila') : null), lista);
  await recarregar();
}

// ---------- Equipe ----------

async function equipe(ctx) {
  const lista = el('div');
  const recarregar = async () => {
    const { itens } = await api.get(`/empresas/${ctx.empresaId}/usuarios`);
    limpar(lista, cartao(null, tabela(['Pessoa', 'Perfil', '^Disponível', '^Em atendimento', 'Máx.', 'Último acesso', '^Ativo', ''],
      itens.map((u) => el('tr', {},
        td(el('span', { class: 'pessoa' }, el('span', { class: 'iniciais' }, iniciais(u.nome)), el('span', {}, u.nome, el('div', { class: 'pequeno mudo' }, u.email)))),
        td(PERFIS[u.perfil]),
        td(['atendente', 'cliente'].includes(u.perfil) ? el('span', { class: `situacao ${u.disponivel ? 'ok' : ''}` }, u.disponivel ? 'sim' : 'não') : '—', 'centro'),
        td(inteiro(u.em_atendimento), 'centro num'),
        td(inteiro(u.max_simultaneas), 'centro num'),
        td(u.ultimo_acesso ? desde(u.ultimo_acesso) : 'nunca entrou'),
        td(u.ativo ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'),
        td(ctx.soAdmin ? botaoIcone('editar', 'Editar', () => editar(u)) : null, 'dir'))))));
  };

  const criar = () => formModal('Nova pessoa na equipe', () => [
    campo('Nome', { name: 'nome', required: true, maxlength: 160 }),
    campo('E-mail (é o login)', { name: 'email', type: 'email', required: true }),
    escolha('Perfil', 'perfil', { atendente: PERFIS.atendente, cliente: PERFIS.cliente, supervisor: PERFIS.supervisor }, 'atendente'),
    campo('Máximo de conversas ao mesmo tempo', { name: 'max_simultaneas', type: 'number', value: 5, min: 1, max: 50 }),
    campo('Senha (vazio gera uma provisória)', { name: 'senha', type: 'password', minlength: 8, autocomplete: 'new-password' }),
  ], async (d) => {
    if (!d.senha) delete d.senha;
    const r = await api.post(`/empresas/${ctx.empresaId}/usuarios`, d);
    await recarregar();
    if (r.senha_provisoria) {
      modal('Pessoa criada', (fechar) => [
        el('p', {}, `${r.usuario.nome} já pode entrar com:`),
        el('pre', { class: 'json' }, `${r.usuario.email}\n${r.senha_provisoria}`),
        el('p', { class: 'mudo pequeno' }, 'Anote agora: a senha não aparece de novo. Peça para trocar no primeiro acesso.'),
        el('div', { class: 'linha entre' }, el('span'), el('button', { class: 'btn primario', onclick: () => fechar() }, 'Entendi')),
      ]);
    } else toast('Pessoa criada.');
  });

  const editar = (u) => formModal(`Editar ${u.nome}`, () => [
    campo('Nome', { name: 'nome', value: u.nome, required: true, maxlength: 160 }),
    escolha('Perfil', 'perfil', { atendente: PERFIS.atendente, cliente: PERFIS.cliente, supervisor: PERFIS.supervisor }, u.perfil),
    campo('Máximo de conversas ao mesmo tempo', { name: 'max_simultaneas', type: 'number', value: u.max_simultaneas, min: 1, max: 50 }),
    campo('Nova senha (vazio mantém)', { name: 'senha', type: 'password', minlength: 8, autocomplete: 'new-password' }),
    marcar('Ativo', { name: 'ativo', checked: u.ativo }),
    u.em_atendimento ? el('p', { class: 'mudo pequeno' }, `Desativar devolve as ${u.em_atendimento} conversa(s) dele para a fila.`) : null,
  ], async (d) => {
    if (!d.senha) delete d.senha;
    await api.patch(`/empresas/${ctx.empresaId}/usuarios/${u.id}`, d);
    toast('Pessoa salva.');
    await recarregar();
  });

  limpar(ctx.conteudo, acoesTopo(el('span'), ctx.soAdmin ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova pessoa') : null), lista);
  await recarregar();
}

// ---------- Contatos ----------

async function contatos(ctx) {
  const estado = { busca: '' };
  const lista = el('div');
  const recarregar = async () => {
    const { itens } = await api.get(`/empresas/${ctx.empresaId}/contatos${qs(estado)}`);
    limpar(lista, cartao(null, tabela(['Contato', 'WhatsApp', 'CPF/CNPJ', '^Conversas', 'Último contato', ''],
      itens.map((c) => el('tr', {},
        td(el('div', {}, el('strong', {}, c.nome ?? c.nome_perfil ?? '—'),
          c.bloqueado ? el('span', { class: 'etiqueta erro', style: 'margin-left:6px' }, 'bloqueado') : null,
          c.aceita_ativo ? null : el('span', { class: 'etiqueta aviso', style: 'margin-left:6px' }, 'sem ativo'))),
        td(formatarTelefone(String(c.telefone).replace(/^55/, ''))),
        td(c.documento ?? '—'),
        td(el('span', {}, inteiro(c.conversas), c.abertas ? el('span', { class: 'etiqueta info', style: 'margin-left:6px' }, 'em aberto') : null), 'centro'),
        td(c.ultimo_contato_em ? desde(c.ultimo_contato_em) : '—'),
        td(ctx.somenteLeitura ? null : el('div', { class: 'linha', style: 'gap:4px' },
          botaoIcone('conversa', c.abertas ? 'Abrir a conversa' : 'Iniciar conversa', () => conversar(c)),
          botaoIcone('editar', 'Editar', () => editar(c))), 'dir'))),
    'Nenhum contato ainda. Eles aparecem aqui assim que alguém mandar mensagem para o seu WhatsApp.')));
  };

  const editar = (c) => formModal(`Editar ${c.nome ?? c.telefone}`, () => [
    campo('Nome', { name: 'nome', value: c.nome ?? '', maxlength: 160 }),
    campo('CPF/CNPJ', { name: 'documento', value: c.documento ?? '', inputmode: 'numeric' }),
    campo('E-mail', { name: 'email', value: c.email ?? '', type: 'email' }),
    campo('Código no sistema da empresa', { name: 'codigo_externo', value: c.codigo_externo ?? '', maxlength: 80 }),
    area('Observações (a equipe vê na conversa)', { name: 'observacoes', rows: 3, maxlength: 2000 }, c.observacoes ?? ''),
    marcar('Bloqueado', { name: 'bloqueado', checked: Boolean(c.bloqueado) }),
    marcar('Aceita mensagens ativas', { name: 'aceita_ativo', checked: c.aceita_ativo !== 0 }),
  ], async (d) => {
    await api.patch(`/empresas/${ctx.empresaId}/contatos/${c.id}`, d);
    toast('Contato salvo.');
    await recarregar();
  });

  const conversar = (c) => formModal(`Falar com ${c.nome ?? c.telefone}`, () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
      'Se o cliente não mandou mensagem nas últimas 24 h, o WhatsApp só aceita template aprovado pela Meta — preencha o nome do template em vez do texto.'),
    campo('Assunto (interno)', { name: 'assunto', maxlength: 160 }),
    area('Mensagem', { name: 'texto', rows: 3, maxlength: 4096 }),
    campo('OU nome do template', { name: 'template', maxlength: 120, placeholder: 'aviso_fatura' }),
    campo('Parâmetros do template (separados por |)', { name: 'parametros' }),
  ], async (d) => {
    const corpo = { assunto: d.assunto };
    if (d.template) Object.assign(corpo, { template: d.template, parametros: d.parametros ? d.parametros.split('|').map((x) => x.trim()).filter(Boolean) : [] });
    else corpo.texto = d.texto;
    const r = await api.post(`/empresas/${ctx.empresaId}/contatos/${c.id}/conversar`, corpo);
    toast('Mensagem na fila de envio.');
    location.hash = `#/empresa/${ctx.empresaId}/caixa?conversa=${r.conversa_id}`;
  }, { rotulo: 'Enviar', largo: true });

  limpar(ctx.conteudo, acoesTopo(campoBusca(estado.busca, (t) => { estado.busca = t; recarregar(); }, 'Nome, telefone ou CPF/CNPJ'), el('span')), lista);
  await recarregar();
}

// ---------- Chamados ----------

async function chamados(ctx) {
  const estado = { status: '', busca: '' };
  const filasDaEmpresa = (await api.get(`/empresas/${ctx.empresaId}/filas`)).itens;
  const lista = el('div');
  const recarregar = async () => {
    const { itens } = await api.get(`/empresas/${ctx.empresaId}/chamados${qs(estado)}`);
    limpar(lista, cartao(null, tabela(['Protocolo', 'Assunto', 'Cliente', 'Fila', 'Aberto por', 'Criado', '^Situação', ''],
      itens.map((ch) => el('tr', {},
        td(el('code', {}, ch.protocolo)),
        td(el('div', {}, el('strong', {}, ch.assunto), ch.descricao ? el('div', { class: 'pequeno mudo' }, String(ch.descricao).slice(0, 90)) : null)),
        td(el('div', {}, ch.contato_nome ?? '—', el('div', { class: 'pequeno mudo' }, formatarTelefone(String(ch.telefone).replace(/^55/, ''))))),
        td(ch.fila_nome ?? '—'),
        td(ch.aberto_por === 'ia' ? el('span', { class: 'etiqueta info' }, 'ZOE') : (ch.usuario_nome ?? 'equipe')),
        td(dataHora(ch.criado_em)),
        td(etiquetaChamado(ch.status), 'centro'),
        td(ctx.somenteLeitura ? null : botaoIcone('editar', 'Atualizar', () => editar(ch)), 'dir'))),
    'Nenhum chamado. A ZOE abre um sempre que o pedido é legítimo mas não tem solução na hora.')));
  };

  const editar = (ch) => formModal(`Chamado ${ch.protocolo}`, () => [
    campo('Assunto', { name: 'assunto', value: ch.assunto, required: true, maxlength: 160 }),
    area('Descrição', { name: 'descricao', rows: 3, maxlength: 4000 }, ch.descricao ?? ''),
    escolha('Fila', 'fila_id', { '': '—', ...Object.fromEntries(filasDaEmpresa.map((f) => [f.id, f.nome])) }, ch.fila_id ?? ''),
    escolha('Situação', 'status', { aberto: 'Aberto', andamento: 'Em andamento', resolvido: 'Resolvido', cancelado: 'Cancelado' }, ch.status),
    area('O que foi feito (obrigatório para resolver ou cancelar)', { name: 'resolucao', rows: 3, maxlength: 4000 }, ch.resolucao ?? ''),
  ], async (d) => {
    await api.patch(`/empresas/${ctx.empresaId}/chamados/${ch.id}`, d);
    toast('Chamado atualizado.');
    await recarregar();
  }, { largo: true });

  limpar(ctx.conteudo, acoesTopo(
    el('div', { class: 'filtros livre' },
      seletor('Situação', { '': 'Todas', aberto: 'Aberto', andamento: 'Em andamento', resolvido: 'Resolvido', cancelado: 'Cancelado' }, estado.status, (v) => { estado.status = v; recarregar(); }),
      campoBusca(estado.busca, (t) => { estado.busca = t; recarregar(); }, 'Protocolo, assunto ou cliente')), el('span')), lista);
  await recarregar();
}

// ---------- Configurações ----------

async function configuracoes(ctx) {
  const conteudo = el('div');
  const recarregar = async () => {
    const [numeros, rapidas, etiquetas] = await Promise.all([
      api.get(`/empresas/${ctx.empresaId}/numeros`),
      api.get(`/empresas/${ctx.empresaId}/respostas-rapidas`),
      api.get(`/empresas/${ctx.empresaId}/etiquetas`),
    ]);
    limpar(conteudo,
      cartao('Número de WhatsApp (Cloud API da Meta)',
        numeros.itens.length ? tabela(['Nome', 'Número', 'Phone number ID', '^Token', '^App secret', 'Último evento', '^Ativo', ''],
          numeros.itens.map((n) => el('tr', {},
            td(n.nome), td(formatarTelefone(String(n.telefone).replace(/^55/, ''))), td(el('code', {}, n.phone_number_id)),
            td(n.token_configurado ? icone('ok') : el('span', { class: 'etiqueta erro' }, 'falta'), 'centro'),
            td(n.app_secret_configurado ? icone('ok') : el('span', { class: 'etiqueta erro' }, 'falta'), 'centro'),
            td(n.ultimo_evento_em ? desde(n.ultimo_evento_em) : 'nenhum'),
            td(n.ativo ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'),
            td(el('div', { class: 'linha', style: 'gap:4px' },
              botaoIcone('ok', 'Testar a conexão com a Meta', () => testarNumero(n)),
              ctx.soAdmin ? botaoIcone('editar', 'Editar', () => editarNumero(n)) : null), 'dir'))))
          : vazio('Nenhum número cadastrado.', 'Sem número, nada entra nem sai do WhatsApp.'),
        el('div', { class: 'aviso-caixa info', style: 'margin-top:12px' }, icone('integracoes'), el('div', {},
          el('strong', {}, 'No painel da Meta, use este endereço de callback:'),
          el('pre', { class: 'json', style: 'margin:6px 0' }, numeros.webhook.url),
          el('div', { class: 'pequeno' }, numeros.webhook.instrucoes))),
        ctx.soAdmin ? el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn primario', onclick: () => editarNumero(null) }, icone('mais'), 'Cadastrar número')) : null),

      cartao('Respostas rápidas',
        el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' }, 'Na conversa, o atendente digita /atalho e o texto entra pronto.'),
        tabela(['Atalho', 'Título', 'Texto', '>Usos', '^Ativa', ''], rapidas.itens.map((rr) => el('tr', {},
          td(el('code', {}, `/${rr.atalho}`)), td(rr.titulo), td(el('span', { class: 'pequeno' }, rr.texto.slice(0, 90))),
          td(inteiro(rr.usos), 'dir num'), td(rr.ativa ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'),
          td(ctx.somenteLeitura ? null : el('div', { class: 'linha', style: 'gap:4px' },
            botaoIcone('editar', 'Editar', () => editarRapida(rr)), botaoIcone('lixo', 'Excluir', () => excluirRapida(rr), 'perigo')), 'dir'))),
        'Nenhuma resposta rápida.'),
        ctx.somenteLeitura ? null : el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: () => editarRapida(null) }, icone('mais'), 'Nova resposta rápida'))),

      cartao('Etiquetas',
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, etiquetas.itens.map((e) => el('span', { class: `tag-escolha ${e.cor} on` },
          e.nome, el('small', { style: 'margin-left:6px;opacity:.7' }, inteiro(e.usos)),
          ctx.soAdmin ? botaoIcone('lixo', 'Excluir', () => excluirEtiqueta(e)) : null))),
        ctx.somenteLeitura ? null : el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: () => criarEtiqueta(etiquetas.cores) }, icone('mais'), 'Nova etiqueta'))));
  };

  const editarNumero = (n) => formModal(n ? `Editar ${n.nome}` : 'Cadastrar número de WhatsApp', () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 8px' },
      'Os dados ficam no painel da Meta (developers.facebook.com): o Phone number ID e o token de acesso em WhatsApp > Configuração da API, '
      + 'e o App secret em Configurações do app > Básico. O token e o App secret são guardados cifrados.'),
    campo('Nome (interno)', { name: 'nome', value: n?.nome ?? 'Principal', required: true, maxlength: 80 }),
    campo('Número com DDD', { name: 'telefone', value: n?.telefone ?? '', required: true, placeholder: '11 3333-4444' }),
    campo('Phone number ID', { name: 'phone_number_id', value: n?.phone_number_id ?? '', required: true, inputmode: 'numeric' }),
    campo('WABA ID (opcional)', { name: 'waba_id', value: n?.waba_id ?? '' }),
    campo(n ? 'Token de acesso (vazio mantém o atual)' : 'Token de acesso permanente', { name: 'token', type: 'password', required: !n, autocomplete: 'off' }),
    campo(n ? 'App secret (vazio mantém o atual)' : 'App secret', { name: 'app_secret', type: 'password', autocomplete: 'off' }),
    campo('Token de verificação do webhook', { name: 'verify_token', value: n?.verify_token ?? '', placeholder: 'vazio gera um automaticamente' }),
    n ? marcar('Ativo', { name: 'ativo', checked: n.ativo }) : null,
  ], async (d) => {
    for (const k of ['token', 'app_secret', 'verify_token']) if (!d[k]) delete d[k];
    if (n) await api.patch(`/empresas/${ctx.empresaId}/numeros/${n.id}`, d);
    else await api.post(`/empresas/${ctx.empresaId}/numeros`, d);
    toast('Número salvo.');
    await recarregar();
  }, { largo: true });

  const testarNumero = async (n) => {
    const s = await api.get(`/empresas/${ctx.empresaId}/numeros/${n.id}/situacao`);
    modal('Conexão com a Meta', (fechar) => [
      el('div', { class: `aviso-caixa ${s.ok ? 'ok' : 'erro'}` }, icone(s.ok ? 'ok' : 'alerta'), el('div', {},
        el('strong', {}, s.ok ? 'Conectado' : `Falhou: ${s.estado}`),
        s.erro ? el('div', { class: 'pequeno' }, s.erro) : null)),
      s.ok ? el('pre', { class: 'json' }, JSON.stringify({ telefone: s.telefone, nome_verificado: s.nome_verificado, qualidade: s.qualidade, verificacao: s.verificacao }, null, 2)) : null,
      el('div', { class: 'linha entre', style: 'margin-top:12px' }, el('span'), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
    ]);
  };

  const editarRapida = (rr) => formModal(rr ? `Editar /${rr.atalho}` : 'Nova resposta rápida', () => [
    campo('Atalho (sem a barra)', { name: 'atalho', value: rr?.atalho ?? '', required: true, placeholder: 'boleto' }),
    campo('Título', { name: 'titulo', value: rr?.titulo ?? '', required: true, maxlength: 80 }),
    area('Texto', { name: 'texto', rows: 4, required: true, maxlength: 4000 }, rr?.texto ?? ''),
    rr ? marcar('Ativa', { name: 'ativa', checked: rr.ativa }) : null,
  ], async (d) => {
    if (rr) await api.patch(`/empresas/${ctx.empresaId}/respostas-rapidas/${rr.id}`, d);
    else await api.post(`/empresas/${ctx.empresaId}/respostas-rapidas`, d);
    toast('Resposta rápida salva.');
    await recarregar();
  }, { largo: true });

  const excluirRapida = async (rr) => {
    if (!await confirmar('Excluir resposta rápida', `/${rr.atalho} deixa de funcionar.`, 'Excluir')) return;
    await api.del(`/empresas/${ctx.empresaId}/respostas-rapidas/${rr.id}`);
    await recarregar();
  };

  const criarEtiqueta = (cores) => formModal('Nova etiqueta', () => [
    campo('Nome', { name: 'nome', required: true, maxlength: 40 }),
    escolha('Cor', 'cor', Object.fromEntries(cores.map((c) => [c, c])), 'azul'),
  ], async (d) => {
    await api.post(`/empresas/${ctx.empresaId}/etiquetas`, d);
    await recarregar();
  });

  const excluirEtiqueta = async (e) => {
    if (!await confirmar('Excluir etiqueta', `"${e.nome}" sai de todas as conversas.`, 'Excluir')) return;
    await api.del(`/empresas/${ctx.empresaId}/etiquetas/${e.id}`);
    await recarregar();
  };

  limpar(ctx.conteudo, conteudo);
  await recarregar();
}

// ---------- Integrações ----------

async function integracoes(ctx) {
  const conteudo = el('div');
  const recarregar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/chaves`);
    limpar(conteudo,
      cartao('Chaves de API',
        el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
          'Com uma chave, o seu sistema envia mensagem pelo WhatsApp, consulta as conversas e fecha os chamados que a ZOE abriu. '
          + 'Guardamos só o hash da chave: ela aparece uma única vez.'),
        tabela(['Nome', 'Prefixo', 'Último uso', 'Criada', '^Ativa', ''], d.itens.map((c) => el('tr', {},
          td(c.nome), td(el('code', {}, `${c.prefixo}…`)), td(c.ultimo_uso ? desde(c.ultimo_uso) : 'nunca'),
          td(dataHora(c.criada_em)), td(c.ativa ? icone('ok') : el('span', { class: 'mudo' }, 'revogada'), 'centro'),
          td(c.ativa ? botaoIcone('lixo', 'Revogar', () => revogar(c), 'perigo') : null, 'dir'))),
        'Nenhuma chave.'),
        el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Gerar chave'))),
      cartao('Como usar',
        el('pre', { class: 'json' }, `Base: ${d.guia.base}\nCabeçalho: ${d.guia.cabecalho}\n\n${d.guia.rotas.join('\n')}`),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
          'Exemplo — avisar o cliente de uma fatura (fora da janela de 24 h, exige template aprovado):'),
        el('pre', { class: 'json' }, `curl -X POST ${d.guia.base}/mensagens \\\n  -H "Authorization: Bearer SUA_CHAVE" \\\n  -H "Content-Type: application/json" \\\n  -d '{"telefone":"11988887777","template":"aviso_fatura","parametros":["João","10/12"]}'`)));
  };

  const criar = () => formModal('Gerar chave de API', () => [campo('Nome (para você reconhecer)', { name: 'nome', required: true, value: 'Integração ERP', maxlength: 80 })], async (d) => {
    const nova = await api.post(`/empresas/${ctx.empresaId}/chaves`, d);
    await recarregar();
    modal('Chave gerada', (fechar) => [
      el('p', {}, 'Copie agora: esta chave não aparece de novo.'),
      el('pre', { class: 'json' }, nova.chave),
      el('div', { class: 'linha entre' }, el('span'), el('button', { class: 'btn primario', onclick: () => fechar() }, 'Copiei')),
    ]);
  });

  const revogar = async (c) => {
    if (!await confirmar('Revogar chave', `"${c.nome}" para de funcionar na hora.`, 'Revogar')) return;
    await api.del(`/empresas/${ctx.empresaId}/chaves/${c.id}`);
    toast('Chave revogada.');
    await recarregar();
  };

  limpar(ctx.conteudo, conteudo);
  await recarregar();
}

// ---------- Relatórios ----------

const relatorios = (ctx) => telaRelatorios(ctx, `/empresas/${ctx.empresaId}/relatorios`, {
  comCsv: `/empresas/${ctx.empresaId}/relatorios/conversas.csv`,
  extras: (d) => [
    cartao('Por fila', tabela(['Fila', '>Conversas', '^Esperando', '>Espera média', '>Atendimento médio', '>CSAT'],
      d.por_fila.map((f) => el('tr', {}, td(f.nome), td(inteiro(f.conversas), 'dir num'), td(inteiro(f.aguardando), 'centro num'),
        td(f.espera_s === null ? '—' : duracao(f.espera_s), 'dir num'), td(f.atendimento_s === null ? '—' : duracao(f.atendimento_s), 'dir num'),
        td(f.csat === null ? '—' : f.csat.toLocaleString('pt-BR'), 'dir num'))))),
    cartao('Por atendente', tabela(['Atendente', '^Disponível', '>Atendidas', '^Agora', '>1ª resposta', '>Atendimento médio', '>CSAT'],
      d.por_atendente.map((a) => el('tr', {}, td(a.nome),
        td(el('span', { class: `situacao ${a.disponivel ? 'ok' : ''}` }, a.disponivel ? 'sim' : 'não'), 'centro'),
        td(inteiro(a.atendidas), 'dir num'), td(inteiro(a.em_atendimento), 'centro num'),
        td(a.primeira_resposta_s === null ? '—' : duracao(a.primeira_resposta_s), 'dir num'),
        td(a.atendimento_s === null ? '—' : duracao(a.atendimento_s), 'dir num'),
        td(a.csat === null ? '—' : `${a.csat.toLocaleString('pt-BR')} (${inteiro(a.avaliacoes)})`, 'dir num'))))),
  ],
});

export const TELAS_EMPRESA = {
  dashboard, caixa: telaCaixa, ia: telaIa, ouvidoria: telaOuvidoria, filas, equipe, contatos, chamados, relatorios, configuracoes, integracoes,
};
