import { api, qs } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, paginacao, abas, etqDe, rotulo, opcoes, dataHora, data, hoje, dl, toast, carregar, formulario, modal,
  botao, faixa, dinheiro, km, placa, vazio } from '../ui.js';

const PROXIMO = { orcado: 'Registrar orçamento', aprovado: 'Aprovar', agendado: 'Agendar', em_execucao: 'Iniciar (bloqueia o veículo)', concluido: 'Concluir', cancelado: 'Cancelar' };

export default async function manutencao({ alvo, query }) {
  const lista = [['agenda', 'Agenda'], ['ordens', 'Ordens'], ['planos', 'Preventivas'], ['fornecedores', 'Fornecedores'], ['custos', 'Custos']];
  let aba = query.aba ?? 'agenda';
  const veiculoFiltro = query.veiculo ? Number(query.veiculo) : null;
  const corpo = el('div');
  const barra = el('div');
  let veiculos = [];
  try { veiculos = (await api.get('/frota/veiculos?por_pagina=200')).itens; } catch { /* a tela mostra o erro nas listas */ }
  const trocar = (id) => { aba = id; barra.replaceChildren(abas(lista, aba, trocar)); TELAS[aba](); };
  limpar(alvo, cabecalho({ sobretitulo: 'Gestão de frota', titulo: 'Manutenção e lavagem',
    descricao: 'Preventivas por data ou quilometragem (vale o primeiro limite), mecânico, lavagem, fornecedores e custos previstos e realizados em separado.',
    acoes: [pode('manutencao.editar') ? botao('Nova ordem', () => novaOrdem(veiculos, veiculoFiltro, () => trocar('ordens')), { ic: 'mais' }) : null,
      pode('manutencao.editar') ? botao('Novo plano preventivo', () => novoPlano(veiculos, veiculoFiltro, () => trocar('planos')), { tipo: 'secundario' }) : null] }),
  veiculoFiltro ? faixa(el('span', {}, `Filtrando pelo veículo ${placa(veiculos.find((v) => v.id === veiculoFiltro)?.placa ?? '')}. `, el('a', { href: '#/manutencao' }, 'Ver todos')), 'info') : null,
  barra, corpo);

  const TELAS = {
    agenda: () => carregar(corpo, () => api.get('/manutencao/agenda'), (a) => el('div', { class: 'grade duas' },
      painel('Ordens em aberto', tabelaOrdens(a.ordens.filter((o) => !veiculoFiltro || veiculos.find((v) => v.placa === o.placa)?.id === veiculoFiltro), () => TELAS.agenda()), { semCorpo: true }),
      painel('Preventivas próximas ou vencidas', a.planos.length ? tabela([
        { titulo: 'Veículo / item', valor: (p) => el('div', {}, el('div', { class: 'forte' }, `${placa(p.placa)} · ${rotulo('itemPlano', p.item)}`), el('div', { class: 'fraco' }, p.motivos.join(' '))) },
        { titulo: 'Limite', valor: (p) => [p.vence_em ? data(p.vence_em) : null, p.vence_km ? km(p.vence_km) : null].filter(Boolean).join(' ou ') },
        { titulo: 'Situação', valor: (p) => el('div', {}, etqDe('situacaoPlano', p.situacao), p.limitacao ? el('div', { class: 'fraco' }, p.limitacao) : null) },
      ], a.planos) : vazio('Nenhuma preventiva próxima.', 'As preventivas cadastradas estão em dia.'), { semCorpo: true }))),
    ordens: (filtro = { pagina: 1, veiculo_id: veiculoFiltro ?? '' }) => carregar(corpo, () => api.get(`/manutencao/ordens${qs(filtro)}`), (l) => painel(null,
      el('div', {}, tabelaOrdens(l.itens, () => TELAS.ordens(filtro)), paginacao(l, (p) => TELAS.ordens({ ...filtro, pagina: p }))), { semCorpo: true })),
    planos: () => carregar(corpo, () => api.get(`/manutencao/planos${qs({ veiculo_id: veiculoFiltro ?? '' })}`), (l) => painel(null, tabela([
      { titulo: 'Veículo', valor: (p) => `${placa(p.placa)} · ${p.modelo}` }, { titulo: 'Item', valor: (p) => `${rotulo('itemPlano', p.item)}${p.descricao ? ` · ${p.descricao}` : ''}` },
      { titulo: 'Periodicidade', valor: (p) => [p.intervalo_dias ? `${p.intervalo_dias} dias` : null, p.intervalo_km ? km(p.intervalo_km) : null].filter(Boolean).join(' ou ') },
      { titulo: 'Último serviço', valor: (p) => `${data(p.ultima_data)}${p.ultimo_km !== null ? ` · ${km(p.ultimo_km)}` : ''}` },
      { titulo: 'Próximo limite', valor: (p) => [p.vence_em ? data(p.vence_em) : null, p.vence_km ? km(p.vence_km) : null].filter(Boolean).join(' ou ') },
      { titulo: 'Situação', valor: (p) => el('div', {}, etqDe('situacaoPlano', p.situacao), p.limitacao ? el('div', { class: 'fraco' }, p.limitacao) : null) },
    ], l, { vazioTexto: 'Nenhum plano preventivo. Cadastre óleo, filtros, pneus, freios e revisão por veículo.' }), { semCorpo: true })),
    fornecedores: () => carregar(corpo, () => api.get('/frota/fornecedores'), (l) => painel(null, tabela([
      { titulo: 'Fornecedor', valor: (f) => el('div', {}, el('div', { class: 'forte' }, f.nome), el('div', { class: 'fraco' }, rotulo('fornecedor', f.tipo))) },
      { titulo: 'Contato', valor: (f) => [f.contato, f.telefone, f.email].filter(Boolean).join(' · ') || '—' }, { titulo: 'Endereço', valor: (f) => f.endereco ?? '—' },
      { titulo: 'Especialidades', valor: (f) => f.especialidades ?? '—' },
    ], l.itens, { vazioTexto: 'Nenhum fornecedor cadastrado.', aoClicar: pode('manutencao.editar') ? (f) => fornecedor(f, () => TELAS.fornecedores()) : null }),
    { semCorpo: true, acoes: [] }), el('div')).then(() => {
      if (pode('manutencao.editar')) corpo.prepend(el('div', { class: 'filtros' }, botao('Novo fornecedor', () => fornecedor(null, () => TELAS.fornecedores()), { ic: 'mais', tipo: 'secundario' })));
    }),
    custos: () => {
      const de = el('input', { type: 'date', value: `${hoje().slice(0, 8)}01`, 'aria-label': 'De' });
      const ate = el('input', { type: 'date', value: hoje(), 'aria-label': 'Até' });
      const area = el('div');
      const atualizar = () => carregar(area, () => api.get(`/manutencao/custos${qs({ de: de.value, ate: ate.value })}`), (c) => painel(`Custos de ${data(c.de)} a ${data(c.ate)}`, tabela([
        { titulo: 'Veículo', valor: (x) => `${placa(x.placa)} · ${x.modelo}` }, { titulo: 'Orçado (previsto)', valor: (x) => dinheiro(x.orcado_centavos), classe: 'num' },
        { titulo: 'Realizado', valor: (x) => dinheiro(x.realizado_centavos), classe: 'num' }, { titulo: 'dos quais lavagem', valor: (x) => dinheiro(x.lavagem_centavos), classe: 'num' },
        { titulo: 'Ordens concluídas', valor: (x) => x.concluidas, classe: 'num' },
      ], c.por_veiculo), { rodape: [el('span', {}, `Total orçado ${dinheiro(c.total.orcado_centavos)} · total realizado ${dinheiro(c.total.realizado_centavos)}`), el('span', {}, c.observacao)] }));
      de.addEventListener('change', atualizar);
      ate.addEventListener('change', atualizar);
      limpar(corpo, el('div', { class: 'filtros' }, el('label', { class: 'campo' }, el('span', {}, 'De'), de), el('label', { class: 'campo' }, el('span', {}, 'Até'), ate)), area);
      atualizar();
    },
  };
  trocar(lista.some(([id]) => id === aba) ? aba : 'agenda');
}

function tabelaOrdens(itens, recarregar) {
  return tabela([
    { titulo: 'Ordem', valor: (o) => el('div', {}, el('div', { class: 'forte' }, o.descricao), el('div', { class: 'fraco' }, [`#${o.id}`, placa(o.placa), rotulo('tipoManutencao', o.tipo), o.fornecedor_nome].filter(Boolean).join(' · '))) },
    { titulo: 'Planejado', valor: (o) => [o.data_planejada ? data(o.data_planejada) : null, o.km_planejado ? km(o.km_planejado) : null].filter(Boolean).join(' · ') || '—' },
    { titulo: 'Indisponível', valor: (o) => (o.indisponivel_inicio ? `${data(o.indisponivel_inicio)} a ${data(o.indisponivel_fim)}` : '—') },
    { titulo: 'Situação', valor: (o) => etqDe('statusManutencao', o.status) },
  ], itens, { vazioTexto: 'Nenhuma ordem.', aoClicar: (o) => detalheOrdem(o.id, recarregar) });
}

async function detalheOrdem(id, recarregar) {
  const o = await api.get(`/manutencao/ordens/${id}`);
  modal(`Ordem #${o.id} · ${placa(o.placa)}`, (fechar) => [
    dl([['Serviço', o.descricao], ['Tipo', `${rotulo('tipoManutencao', o.tipo)}${o.lavagem_tipo ? ` · ${o.lavagem_tipo}` : ''}${o.plano_item ? ` · plano ${rotulo('itemPlano', o.plano_item)}` : ''}`],
      ['Situação', etqDe('statusManutencao', o.status)], ['Fornecedor', o.fornecedor_nome], ['Planejado', [o.data_planejada ? data(o.data_planejada) : null, o.km_planejado ? km(o.km_planejado) : null].filter(Boolean).join(' · ')],
      ['Previsão de indisponibilidade', o.indisponivel_inicio ? `${data(o.indisponivel_inicio)} a ${data(o.indisponivel_fim)}` : null],
      ['Custo previsto', dinheiro(o.custo_previsto_centavos)], ['Custo realizado', dinheiro(o.custo_realizado_centavos)], ['Aprovado', o.aprovado_em ? dataHora(o.aprovado_em) : null],
      ['Concluído', o.concluido_em ? `${dataHora(o.concluido_em)}${o.km_execucao ? ` · ${km(o.km_execucao)}` : ''}` : null], ['Observações', o.observacoes]]),
    o.itens.length ? el('div', { style: 'margin-top:14px' }, tabela([{ titulo: 'Item', valor: (i) => `${i.tipo === 'peca' ? 'Peça' : 'Serviço'}: ${i.descricao}` },
      { titulo: 'Previsto', valor: (i) => dinheiro(i.previsto_centavos), classe: 'num' }], o.itens)) : null,
    el('div', { style: 'margin-top:14px' }, el('strong', {}, 'Histórico'), el('ul', { class: 'linha-tempo', style: 'margin-top:8px' }, o.eventos.map((e) => el('li', {}, rotulo('statusManutencao', e.para),
      e.observacao ? ` — ${e.observacao}` : '', el('small', {}, `${dataHora(e.em)} · ${e.usuario_nome ?? ''}`))))),
    pode('manutencao.editar') && o.proximos.length ? el('div', { class: 'form-acoes' }, o.proximos.map((p) => botao(PROXIMO[p], () => avancar(o, p, () => { fechar(); recarregar(); }),
      { tipo: p === 'cancelado' ? 'perigo' : p === o.proximos[0] ? '' : 'secundario' }))) : null,
  ], { largo: true });
}

function avancar(o, para, depois) {
  const campos = {
    orcado: [{ nome: 'custo_previsto', rotulo: 'Custo previsto (R$)', tipo: 'decimal', obrigatorio: true }],
    agendado: [{ nome: 'data_planejada', rotulo: 'Data agendada', tipo: 'date', obrigatorio: true, valor: o.data_planejada }],
    concluido: [{ nome: 'custo_realizado', rotulo: 'Custo realizado (R$)', tipo: 'decimal', obrigatorio: true }, { nome: 'km_execucao', rotulo: 'Odômetro na execução (km)', tipo: 'number' }],
    cancelado: [{ nome: 'observacao', rotulo: 'Motivo do cancelamento', obrigatorio: true, inteiro: true }],
  }[para] ?? [];
  return formulario(PROXIMO[para], [...campos, para !== 'cancelado' ? { nome: 'observacao', rotulo: 'Observação', inteiro: true } : null],
    { rotuloEnviar: PROXIMO[para], antes: para === 'aprovado' ? faixa('Orçamentos acima da alçada configurada só podem ser aprovados pelo administrador.', 'info') : null,
      enviar: async (d) => { await api.post(`/manutencao/ordens/${o.id}/status`, { status: para, versao: o.versao, ...d }); toast('Ordem atualizada.'); depois(); } });
}

async function novaOrdem(veiculos, veiculoId, depois) {
  const [forn, planos] = await Promise.all([api.get('/frota/fornecedores'), api.get('/manutencao/planos')]);
  return formulario('Nova ordem de manutenção ou lavagem', [
    { nome: 'veiculo_id', rotulo: 'Veículo', tipo: 'select', obrigatorio: true, valor: veiculoId, opcoes: veiculos.map((v) => [v.id, `${placa(v.placa)} · ${v.modelo}`]) },
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', obrigatorio: true, opcoes: opcoes('tipoManutencao') },
    { nome: 'plano_id', rotulo: 'Plano preventivo (só preventiva)', tipo: 'select', vazio: 'Nenhum', opcoes: planos.map((p) => [p.id, `${placa(p.placa)} · ${rotulo('itemPlano', p.item)}`]),
      ajuda: 'Concluir a ordem reinicia apenas este plano.' },
    { nome: 'lavagem_tipo', rotulo: 'Tipo de lavagem', placeholder: 'simples, completa…' },
    { nome: 'descricao', rotulo: 'Descrição', obrigatorio: true, inteiro: true },
    { nome: 'fornecedor_id', rotulo: 'Fornecedor', tipo: 'select', vazio: 'A definir', opcoes: forn.itens.map((f) => [f.id, `${f.nome} · ${rotulo('fornecedor', f.tipo)}`]) },
    { nome: 'custo_previsto', rotulo: 'Orçamento (R$)', tipo: 'decimal', ajuda: 'Com orçamento, a ordem nasce como "orçada" e precisa de aprovação.' },
    { nome: 'data_planejada', rotulo: 'Data planejada', tipo: 'date' }, { nome: 'km_planejado', rotulo: 'Km planejado', tipo: 'number' },
    { nome: 'indisponivel_inicio', rotulo: 'Indisponível de', tipo: 'date' }, { nome: 'indisponivel_fim', rotulo: 'até', tipo: 'date' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true },
  ], { largo: true, rotuloEnviar: 'Criar ordem', enviar: async (d) => {
    await api.post('/manutencao/ordens', { ...d, plano_id: d.plano_id || null, fornecedor_id: d.fornecedor_id || null, km_planejado: d.km_planejado || null });
    toast('Ordem criada.');
    depois();
  } });
}

function novoPlano(veiculos, veiculoId, depois) {
  return formulario('Plano preventivo', [
    { nome: 'veiculo_id', rotulo: 'Veículo', tipo: 'select', obrigatorio: true, valor: veiculoId, opcoes: veiculos.map((v) => [v.id, `${placa(v.placa)} · ${v.modelo}`]) },
    { nome: 'item', rotulo: 'Item', tipo: 'select', obrigatorio: true, opcoes: opcoes('itemPlano') },
    { nome: 'intervalo_dias', rotulo: 'A cada (dias)', tipo: 'number' }, { nome: 'intervalo_km', rotulo: 'A cada (km)', tipo: 'number' },
    { nome: 'antecedencia_dias', rotulo: 'Avisar com antecedência (dias)', tipo: 'number', valor: 15 }, { nome: 'antecedencia_km', rotulo: 'Avisar com antecedência (km)', tipo: 'number', valor: 500 },
    { nome: 'tolerancia_dias', rotulo: 'Tolerância (dias)', tipo: 'number', valor: 0 }, { nome: 'tolerancia_km', rotulo: 'Tolerância (km)', tipo: 'number', valor: 0 },
    { nome: 'ultima_data', rotulo: 'Último serviço válido em', tipo: 'date', obrigatorio: true }, { nome: 'ultimo_km', rotulo: 'Km do último serviço', tipo: 'number' },
    { nome: 'descricao', rotulo: 'Descrição', inteiro: true },
  ], { largo: true, antes: faixa('Alerta pelo primeiro limite atingido (data ou km). Sem odômetro confiável, vale só a data.', 'info'),
    enviar: async (d) => {
      const n = (x) => (x === '' ? null : x);
      await api.post('/manutencao/planos', { ...d, intervalo_dias: n(d.intervalo_dias), intervalo_km: n(d.intervalo_km), ultimo_km: n(d.ultimo_km) });
      toast('Plano criado.');
      depois();
    } });
}

function fornecedor(f, depois) {
  return formulario(f ? 'Editar fornecedor' : 'Novo fornecedor', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: f?.nome, inteiro: true },
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', obrigatorio: true, opcoes: opcoes('fornecedor'), valor: f?.tipo },
    { nome: 'documento', rotulo: 'CNPJ/CPF', valor: f?.documento }, { nome: 'contato', rotulo: 'Contato', valor: f?.contato },
    { nome: 'telefone', rotulo: 'Telefone', valor: f?.telefone }, { nome: 'email', rotulo: 'E-mail', tipo: 'email', valor: f?.email },
    { nome: 'endereco', rotulo: 'Endereço', valor: f?.endereco, inteiro: true }, { nome: 'especialidades', rotulo: 'Especialidades', valor: f?.especialidades, inteiro: true },
    { nome: 'observacoes', rotulo: 'Observações / orçamento', tipo: 'textarea', valor: f?.observacoes, inteiro: true },
  ], { enviar: async (d) => { await (f ? api.patch(`/frota/fornecedores/${f.id}`, d) : api.post('/frota/fornecedores', d)); toast('Fornecedor salvo.'); depois(); } });
}
