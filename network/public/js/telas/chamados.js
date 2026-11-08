import { api, abrirAnexo, qs } from '../api.js';
import { el, limpar, icone, pode, usuario, cabecalho, painel, tabela, paginacao, etqDe, etq, rotulo, opcoes, dataHora, dl, toast, acao, carregar, carregando,
  formulario, confirmar, pedirMotivo, botao, faixa, localParaIso, isoParaLocal, placa, vazio, dinheiro, R } from '../ui.js';

const COLUNAS = [['aberto', 'Abertos', ['aberto', 'retornado']], ['atribuido', 'Atribuídos', ['atribuido', 'em_rota']], ['em_execucao', 'Em execução', ['em_execucao']],
  ['em_validacao', 'Em validação', ['em_validacao']], ['aprovado', 'Aprovados (30 dias)', ['aprovado']]];

/** Formulário de novo chamado (usado também na Visão geral e no NOC). */
export async function novoChamado(padrao = {}) {
  const ativos = pode('rede.ver') ? (await api.get('/rede/ativos?por_pagina=200')).itens : [];
  return formulario('Novo chamado', [
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', opcoes: opcoes('tipoChamado'), obrigatorio: true, valor: padrao.tipo ?? 'reparo' },
    { nome: 'prioridade', rotulo: 'Prioridade', tipo: 'select', opcoes: opcoes('prioridade'), obrigatorio: true, valor: padrao.prioridade ?? 'media', vazio: false },
    { nome: 'titulo', rotulo: 'Título', obrigatorio: true, inteiro: true, valor: padrao.titulo },
    { nome: 'descricao', rotulo: 'Descrição', tipo: 'textarea', inteiro: true },
    { nome: 'cliente_ref', rotulo: 'Cliente (código ou contrato)', ajuda: 'Opcional' },
    { nome: 'bairro', rotulo: 'Bairro' },
    { nome: 'endereco', rotulo: 'Endereço', inteiro: true },
    ativos.length ? { nome: 'ativo_id', rotulo: 'Ativo da rede', tipo: 'select', opcoes: ativos.map((a) => [a.id, `${a.codigo} · ${rotulo('tipoAtivo', a.tipo)}`]), vazio: 'Nenhum', valor: padrao.ativo_id } : null,
    { nome: 'agendado_para', rotulo: 'Agendado para', tipo: 'datetime-local' },
    { nome: 'prazo', rotulo: 'Prazo', tipo: 'datetime-local' },
  ], { rotuloEnviar: 'Criar chamado', largo: true, enviar: async (d) => {
    const c = await api.post('/chamados', { ...d, ativo_id: d.ativo_id || null, incidente_id: padrao.incidente_id ?? null,
      agendado_para: localParaIso(d.agendado_para), prazo: localParaIso(d.prazo) });
    toast(`Chamado #${c.numero} criado.`);
    return c;
  } });
}

export default async function chamados({ alvo, params, query, ir }) {
  if (params[0] && /^\d+$/.test(params[0])) return detalhe(alvo, Number(params[0]), ir);
  let vista = query.vista || (window.matchMedia('(max-width: 900px)').matches ? 'lista' : 'kanban');
  const filtros = { busca: query.busca ?? '', prioridade: '', tecnico_id: '', pagina: 1 };
  const corpo = el('div');
  const busca = el('input', { type: 'search', class: 'busca', placeholder: 'Número, título, endereço ou cliente', value: filtros.busca, 'aria-label': 'Buscar chamados' });
  const prioridade = el('select', { 'aria-label': 'Prioridade' }, el('option', { value: '' }, 'Todas as prioridades'), opcoes('prioridade').map(([v, r]) => el('option', { value: v }, r)));
  busca.addEventListener('input', () => { filtros.busca = busca.value; filtros.pagina = 1; clearTimeout(busca.t); busca.t = setTimeout(atualizar, 300); });
  prioridade.addEventListener('change', () => { filtros.prioridade = prioridade.value; filtros.pagina = 1; atualizar(); });
  const ehTecnico = usuario().perfil === 'tecnico';
  const trocaVista = el('div', { class: 'alternador', role: 'group', 'aria-label': 'Visualização' });

  limpar(alvo,
    cabecalho({ sobretitulo: 'Operação técnica', titulo: ehTecnico ? 'Meus chamados' : 'Chamados técnicos', descricao: 'Distribua, acompanhe a execução e valide os serviços. A aprovação habilita a comissão.',
      acoes: [pode('chamados.criar') ? botao('Novo chamado', async () => { const c = await novoChamado(); if (c) ir(`#/chamados/${c.id}`); }, { ic: 'mais' }) : null,
        pode('chamados.checklists') ? botao('Checklists', () => checklists(), { tipo: 'secundario', ic: 'ok' }) : null] }),
    el('div', { class: 'filtros' }, busca, prioridade, trocaVista), corpo);

  async function atualizar() {
    trocaVista.replaceChildren(...[['kanban', 'Kanban'], ['lista', 'Lista']].map(([id, r]) => el('button', { 'aria-pressed': String(vista === id), onclick: () => { vista = id; atualizar(); } }, r)));
    await carregar(corpo, () => api.get(`/chamados${qs({ busca: filtros.busca, prioridade: filtros.prioridade, pagina: vista === 'lista' ? filtros.pagina : 1, por_pagina: vista === 'lista' ? 50 : 200 })}`), (l) => {
      if (vista === 'lista') {
        return painel(null, tabela([
          { titulo: 'Nº', valor: (c) => `#${c.numero}`, classe: 'num' },
          { titulo: 'Chamado', valor: (c) => el('div', {}, el('div', { class: 'forte' }, c.titulo), el('div', { class: 'fraco' }, [rotulo('tipoChamado', c.tipo), c.bairro, c.ativo_codigo].filter(Boolean).join(' · '))) },
          { titulo: 'Prioridade', valor: (c) => el('span', {}, el('span', { class: `prioridade ${c.prioridade}` }), ' ', rotulo('prioridade', c.prioridade)) },
          { titulo: 'Técnico / veículo', valor: (c) => el('div', {}, c.tecnico_nome ?? '—', c.veiculo_placa ? el('div', { class: 'fraco' }, placa(c.veiculo_placa)) : null) },
          { titulo: 'Agenda', valor: (c) => dataHora(c.agendado_para) },
          { titulo: 'Prazo', valor: (c) => dataHora(c.prazo) },
          { titulo: 'Situação', valor: (c) => etqDe('statusChamado', c.status) },
        ], l.itens, { vazioTexto: 'Nenhum chamado encontrado.', aoClicar: (c) => ir(`#/chamados/${c.id}`), pagina: paginacao(l, (p) => { filtros.pagina = p; atualizar(); }) }), { semCorpo: true });
      }
      const limite = Date.now() - 30 * 86400_000;
      return el('div', { class: 'kanban' }, COLUNAS.map(([id, titulo, sts]) => {
        const itens = l.itens.filter((c) => sts.includes(c.status) && (c.status !== 'aprovado' || Date.parse(c.aprovado_em ?? c.atualizado_em) > limite));
        return el('section', { class: 'coluna', 'aria-label': titulo }, el('h3', {}, titulo, el('span', {}, itens.length)),
          itens.length ? itens.map((c) => el('button', { class: 'cartao', onclick: () => ir(`#/chamados/${c.id}`) },
            el('div', { class: 'topo-cartao' }, el('span', {}, `#${c.numero} · ${rotulo('tipoChamado', c.tipo)}`), el('span', {}, el('span', { class: `prioridade ${c.prioridade}`, title: rotulo('prioridade', c.prioridade) }))),
            el('strong', {}, c.titulo),
            el('div', { class: 'meta' }, c.bairro ? el('span', {}, c.bairro) : null, el('span', {}, c.tecnico_nome ?? 'Sem técnico'), c.prazo ? el('span', {}, icone('relogio'), dataHora(c.prazo)) : null,
              c.status === 'retornado' ? etq('Retornado', 'erro') : c.status === 'em_rota' ? etq('Em rota', 'info') : null)))
            : el('p', { class: 'vazio' }, 'Vazio'));
      }));
    });
  }
  await atualizar();
}

async function detalhe(alvo, id, ir) {
  const recarregar = () => detalhe(alvo, id, ir);
  limpar(alvo, carregando());
  let c;
  try { c = await api.get(`/chamados/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  const meu = c.tecnico_id === usuario().tecnico_id || c.equipe.some((e) => e.tecnico_id === usuario().tecnico_id);
  const executa = pode('chamados.executar') && (usuario().perfil !== 'tecnico' || meu);
  const enviar = async (caminho, corpo = {}) => { await api.post(`/chamados/${id}/${caminho}`, { versao: c.versao, ...corpo }); recarregar(); };

  const acoes = [];
  if (pode('chamados.atribuir') && ['aberto', 'atribuido', 'retornado'].includes(c.status)) acoes.push(botao(c.tecnico_id ? 'Redistribuir' : 'Atribuir', () => atribuir(c, recarregar), { ic: 'equipe' }));
  if (executa && c.status === 'atribuido') acoes.push(botao('Iniciar deslocamento', () => enviar('iniciar-rota'), { ic: 'rota', tipo: 'grande' }));
  if (executa && ['atribuido', 'em_rota', 'retornado'].includes(c.status) && c.tecnico_id) acoes.push(botao(c.status === 'retornado' ? 'Retomar execução' : 'Iniciar execução', () => enviar('iniciar'), { ic: 'tocar', tipo: c.status === 'atribuido' ? 'secundario' : 'grande' }));
  if (executa && c.status === 'em_execucao') acoes.push(botao('Concluir atendimento', () => formulario('Concluir atendimento', [{ nome: 'observacao', rotulo: 'Observação final', tipo: 'textarea', inteiro: true }],
    { rotuloEnviar: 'Concluir', enviar: (d) => enviar('concluir', d) }), { ic: 'ok', tipo: 'grande' }));
  if (pode('chamados.validar') && c.status === 'em_validacao') {
    acoes.push(botao('Aprovar serviço', async () => {
      if (!(await confirmar('Aprovar serviço', 'A aprovação libera a comissão conforme a regra vigente. O incidente associado, se houver, não é resolvido automaticamente.', 'Aprovar'))) return;
      const r = await api.post(`/chamados/${id}/validar`, { decisao: 'aprovar', versao: c.versao });
      toast(r.aviso_comissao ?? `Aprovado. ${r.comissoes_geradas.length} comissão(ões) para aprovação.`);
      recarregar();
    }, { ic: 'ok' }));
    acoes.push(botao('Retornar ao técnico', () => pedirMotivo('Retornar ao técnico', 'Motivo da devolução', (m) => enviar('validar', { decisao: 'retornar', motivo: m })), { tipo: 'secundario' }));
  }
  if (pode('chamados.validar') && c.status === 'aprovado') acoes.push(botao('Reabrir', () => pedirMotivo('Reabrir chamado aprovado', 'Motivo da reabertura', async (m) => {
    const r = await api.post(`/chamados/${id}/reabrir`, { motivo: m, versao: c.versao });
    if (r.aviso) toast(r.aviso);
    recarregar();
  }, { ajuda: 'O histórico é mantido. Comissões ainda não pagas ficam suspensas; pagas exigem ajuste em Equipe e comissões.' }), { tipo: 'secundario' }));
  if (pode('chamados.atribuir') && ['aberto', 'atribuido', 'em_rota', 'retornado'].includes(c.status)) {
    acoes.push(botao('Reagendar', () => formulario('Reagendar', [{ nome: 'agendado_para', rotulo: 'Nova data e hora', tipo: 'datetime-local', obrigatorio: true, valor: isoParaLocal(c.agendado_para) },
      { nome: 'motivo', rotulo: 'Motivo', obrigatorio: true }], { enviar: (d) => enviar('reagendar', { agendado_para: localParaIso(d.agendado_para), motivo: d.motivo }) }), { tipo: 'secundario', ic: 'calendario' }));
  }
  if (pode('chamados.atribuir') && !['aprovado', 'cancelado'].includes(c.status)) acoes.push(botao('Cancelar', () => pedirMotivo('Cancelar chamado', 'Motivo do cancelamento', (m) => enviar('cancelar', { motivo: m })), { tipo: 'perigo' }));

  const feitos = c.checklist.itens.filter((i) => i.resposta && (i.tipo !== 'foto' || i.resposta.anexo_id) && (i.tipo !== 'confirmacao' || i.resposta.valor === 'sim')).length;
  limpar(alvo,
    el('a', { href: '#/chamados', class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Chamados'),
    cabecalho({ sobretitulo: `Chamado #${c.numero} · ${rotulo('tipoChamado', c.tipo)}`, titulo: c.titulo, descricao: c.descricao, acoes }),
    c.status === 'retornado' ? faixa(`Retornado: ${c.eventos.filter((e) => e.para === 'retornado').at(-1)?.observacao ?? ''}`, 'erro', 'alerta') : null,
    c.incidente_id ? faixa(el('span', {}, 'Associado ao incidente ', el('a', { href: `#/noc/incidente/${c.incidente_id}` }, `#${c.incidente_id} ${c.incidente_titulo}`), ` (${rotulo('statusIncidente', c.incidente_status)}). Concluir este chamado não resolve o incidente: a recuperação precisa de evidência própria.`), 'info') : null,
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel(`Checklist ${c.checklist.modelo ? `(v${c.checklist.modelo.versao})` : ''}`, checklist(c, executa, recarregar), { acoes: [etq(`${feitos}/${c.checklist.itens.length}`, feitos === c.checklist.itens.length ? 'ok' : 'neutra')] }),
        painel('Evidências e anexos', evidencias(c, executa, recarregar)),
        painel('Histórico', el('ul', { class: 'linha-tempo' }, c.eventos.map((e) => el('li', {}, el('strong', {}, e.acao.replaceAll('_', ' ')), e.observacao ? ` — ${e.observacao}` : '',
          el('small', {}, `${dataHora(e.em)} · ${e.usuario_nome ?? 'Sistema'}`)))))),
      el('div', {},
        painel('Situação', dl([
          ['Situação', etqDe('statusChamado', c.status)], ['Prioridade', el('span', {}, el('span', { class: `prioridade ${c.prioridade}` }), ' ', rotulo('prioridade', c.prioridade))],
          ['Técnico', c.tecnico_nome], c.equipe.length ? ['Equipe (rateio)', c.equipe.map((e) => `${e.nome} ${e.percentual}%`).join(', ')] : null,
          ['Veículo', c.veiculo_placa ? el('a', { href: `#/veiculos/${c.veiculo_id}` }, `${placa(c.veiculo_placa)} · ${c.veiculo_modelo}`) : '—'],
          ['Agendado', dataHora(c.agendado_para)], ['Prazo', dataHora(c.prazo)], ['Cliente', c.cliente_ref], ['Bairro', c.bairro], ['Endereço', c.endereco],
          ['Ativo', c.ativo_id ? el('a', { href: `#/rede/ativo/${c.ativo_id}` }, c.ativo_codigo) : '—'],
          c.lat !== null ? ['Localização', el('a', { href: `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=18/${c.lat}/${c.lng}`, target: '_blank', rel: 'noopener' }, 'Abrir no mapa', icone('externo'))] : null,
          ['Retrabalho', c.retrabalho ? `${c.retrabalho} vez(es)` : 'Não'],
        ])),
        c.comissoes.length ? painel('Comissões', tabela([{ titulo: 'Técnico', valor: (x) => x.tecnico_nome }, { titulo: 'Valor', valor: (x) => dinheiro(x.valor_centavos), classe: 'num' },
          { titulo: 'Situação', valor: (x) => etqDe('statusComissao', x.status) }], c.comissoes), { semCorpo: true }) : null)));
}

function checklist(c, executa, recarregar) {
  if (!c.checklist.itens.length) return vazio('Sem checklist para este tipo de serviço.');
  const editavel = executa && c.status === 'em_execucao';
  const salvar = (chave, corpo) => api.put(`/chamados/${c.id}/checklist/${encodeURIComponent(chave)}`, corpo).then(recarregar);
  return el('div', { class: 'checklist' }, c.checklist.itens.map((i) => {
    const r = i.resposta;
    const feito = r && (i.tipo === 'foto' ? r.anexo_id : i.tipo === 'confirmacao' ? r.valor === 'sim' : r.valor);
    const linha = el('div', { class: 'acoes-item' });
    if (i.tipo === 'confirmacao') {
      linha.append(editavel ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: r?.valor === 'sim', onchange: (e) => acao(null, () => salvar(i.chave, { valor: e.target.checked })) }), 'Confirmado')
        : el('span', { class: 'fraco' }, r?.valor === 'sim' ? 'Confirmado' : 'Não confirmado'));
    } else if (i.tipo === 'foto') {
      if (r?.anexo_id) linha.append(el('button', { class: 'botao secundario pequeno', onclick: () => acao(null, () => abrirAnexo(r.anexo_id)) }, icone('camera'), 'Ver foto'));
      if (editavel) {
        const arq = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', capture: 'environment', class: 'sr', id: `foto-${i.chave}` });
        arq.addEventListener('change', () => acao(null, async () => {
          const a = await api.enviarArquivo('chamado', c.id, arq.files[0]);
          await salvar(i.chave, { anexo_id: a.id });
          toast('Foto registrada.');
        }));
        linha.append(arq, el('label', { for: `foto-${i.chave}`, class: 'botao pequeno' }, icone('camera'), r?.anexo_id ? 'Trocar foto' : 'Tirar / enviar foto'));
      }
    } else if (editavel) {
      const inp = el('input', { type: 'text', inputmode: i.tipo === 'numero' ? 'decimal' : null, value: r?.valor ? (i.tipo === 'numero' ? String(r.valor).replace('.', ',') : r.valor) : '', placeholder: i.unidade ?? '', 'aria-label': i.rotulo });
      linha.append(inp, el('button', { class: 'botao secundario pequeno', onclick: (e) => acao(e.currentTarget, () => salvar(i.chave, { valor: inp.value })) }, 'Salvar'), i.unidade ? el('span', { class: 'fraco' }, i.unidade) : null);
    } else linha.append(el('span', {}, r?.valor ? `${i.tipo === 'numero' ? Number(r.valor).toLocaleString('pt-BR') : r.valor}${i.unidade ? ` ${i.unidade}` : ''}` : el('span', { class: 'fraco' }, 'Não informado')));
    return el('div', { class: `item-check${feito ? ' feito' : ''}` }, el('span', { class: 'marca-ok' }, feito ? icone('ok') : null),
      el('div', {}, el('strong', {}, i.rotulo, i.obrigatorio ? el('span', { class: 'fraco' }, ' · obrigatório') : null), r ? el('div', { class: 'fraco' }, `Registrado ${dataHora(r.em)}`) : null, linha));
  }));
}

function evidencias(c, executa, recarregar) {
  const arq = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf', class: 'sr', id: 'anexo-chamado' });
  arq.addEventListener('change', () => acao(null, async () => { await api.enviarArquivo('chamado', c.id, arq.files[0]); toast('Anexo enviado.'); recarregar(); }));
  return el('div', {},
    c.anexos.length ? el('div', { class: 'miniaturas' }, c.anexos.map((a) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); acao(null, () => abrirAnexo(a.id)); } }, icone(a.mime.startsWith('image/') ? 'camera' : 'arquivo'), a.nome)))
      : el('p', { class: 'fraco' }, 'Nenhum anexo.'),
    executa && !['aprovado', 'cancelado'].includes(c.status) ? el('div', { style: 'margin-top:12px' }, arq, el('label', { for: 'anexo-chamado', class: 'botao secundario pequeno' }, icone('mais'), 'Anexar arquivo')) : null);
}

async function atribuir(c, recarregar) {
  const [tecnicos, veiculos] = await Promise.all([api.get('/equipe/tecnicos?ativos=1'), pode('frota.ver') ? api.get('/frota/veiculos?ativos=1').then((x) => x.itens) : []]);
  const enviar = async (d, aceitar = false) => {
    const equipe = d.auxiliar ? [{ tecnico_id: Number(d.tecnico_id), percentual: 100 - Number(d.percentual_auxiliar || 50) }, { tecnico_id: Number(d.auxiliar), percentual: Number(d.percentual_auxiliar || 50) }] : [];
    try {
      await api.post(`/chamados/${c.id}/atribuir`, { tecnico_id: Number(d.tecnico_id), veiculo_id: d.veiculo_id ? Number(d.veiculo_id) : null, agendado_para: localParaIso(d.agendado_para),
        equipe, versao: c.versao, aceitar_conflito: aceitar });
    } catch (err) {
      if (err.status === 409 && err.dados?.detalhes?.conflitos) {
        const lista = err.dados.detalhes.conflitos.map((x) => `#${x.numero} ${x.titulo} (${dataHora(x.agendado_para)})`).join('; ');
        if (await confirmar('Conflito de agenda', `${err.message} ${lista}`, 'Manter mesmo assim')) return enviar(d, true);
        throw new Error('Atribuição não concluída por conflito de agenda.');
      }
      throw err;
    }
    toast('Chamado atribuído.');
    recarregar();
    return true;
  };
  return formulario('Atribuir técnico e veículo', [
    { nome: 'tecnico_id', rotulo: 'Técnico', tipo: 'select', obrigatorio: true, valor: c.tecnico_id, opcoes: tecnicos.map((t) => [t.id, `${t.nome}${t.chamados_ativos ? ` · ${t.chamados_ativos} ativo(s)` : ''}`]) },
    { nome: 'veiculo_id', rotulo: 'Veículo', tipo: 'select', vazio: 'Sem veículo', valor: c.veiculo_id,
      opcoes: veiculos.map((v) => [v.id, `${placa(v.placa)} · ${v.modelo} · ${rotulo('statusVeiculo', v.status)}${v.restricoes.length ? ` (${v.restricoes.map((r) => r.motivo).join('; ')})` : ''}`]),
      ajuda: 'Veículo em oficina ou com restrição é recusado pelo servidor, com o motivo.' },
    { nome: 'agendado_para', rotulo: 'Agendado para', tipo: 'datetime-local', valor: isoParaLocal(c.agendado_para) },
    { tipo: 'secao', rotulo: 'Equipe (opcional)' },
    { nome: 'auxiliar', rotulo: 'Técnico auxiliar', tipo: 'select', vazio: 'Nenhum', opcoes: tecnicos.map((t) => [t.id, t.nome]) },
    { nome: 'percentual_auxiliar', rotulo: 'Rateio do auxiliar (%)', tipo: 'number', valor: 50, min: 1, max: 99, ajuda: 'O principal fica com o restante; a soma nunca passa do valor aprovado.' },
  ], { rotuloEnviar: 'Atribuir', enviar: (d) => enviar(d) });
}

async function checklists() {
  const lista = await api.get('/chamados/checklists');
  const TIPOS = R.tipoChamado;
  return formulario('Checklists por tipo de serviço', [
    { nome: 'tipo_servico', rotulo: 'Tipo de serviço', tipo: 'select', obrigatorio: true, opcoes: Object.entries(TIPOS), inteiro: true },
    { nome: 'itens', rotulo: 'Itens (um por linha: rótulo | tipo | obrigatório)', tipo: 'textarea', linhas: 7, obrigatorio: true, inteiro: true,
      ajuda: 'Tipos: confirmacao, numero, texto, foto. Ex.: "Potência final | numero | sim". Salvar cria uma nova versão; chamados existentes mantêm a anterior.' },
  ], { rotuloEnviar: 'Criar nova versão', largo: true, antes: el('div', { style: 'margin-bottom:14px' }, tabela([
    { titulo: 'Tipo', valor: (m) => TIPOS[m.tipo_servico] }, { titulo: 'Versão', valor: (m) => `v${m.versao}` },
    { titulo: 'Itens', valor: (m) => m.itens.map((i) => `${i.rotulo}${i.obrigatorio ? '*' : ''}`).join(', ') }], lista)),
  enviar: async (d) => {
    const itens = d.itens.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [rot, tipo = 'texto', obr = 'sim'] = l.split('|').map((x) => x.trim());
      return { rotulo: rot, tipo, obrigatorio: /^s/i.test(obr) };
    });
    await api.post('/chamados/checklists', { tipo_servico: d.tipo_servico, itens });
    toast('Nova versão do checklist criada.');
  } });
}
