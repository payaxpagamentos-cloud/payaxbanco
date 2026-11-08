import { api, abrirAnexo, qs } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, paginacao, etqDe, rotulo, opcoes, dataHora, desde, data, dl, toast, acao, carregar, carregando, formulario,
  pedirMotivo, botao, faixa, dinheiro, km, litros, placa, vazio } from '../ui.js';

export default async function veiculos({ alvo, params, query, ir }) {
  if (params[0]) return detalhe(alvo, Number(params[0]), ir);
  const filtro = { busca: query.busca ?? '', status: '', pagina: 1 };
  const corpo = el('div');
  const busca = el('input', { type: 'search', class: 'busca', placeholder: 'Placa, modelo ou identificação', value: filtro.busca, 'aria-label': 'Buscar veículos' });
  const status = el('select', { 'aria-label': 'Situação' }, el('option', { value: '' }, 'Todas as situações'), opcoes('statusVeiculo').map(([v, r]) => el('option', { value: v }, r)));
  busca.addEventListener('input', () => { filtro.busca = busca.value; clearTimeout(busca.t); busca.t = setTimeout(atualizar, 300); });
  status.addEventListener('change', () => { filtro.status = status.value; atualizar(); });
  limpar(alvo, cabecalho({ sobretitulo: 'Gestão de frota', titulo: 'Veículos', descricao: 'Estado real de cada veículo: restrições ativas tiram o veículo da escala até a liberação.',
    acoes: [pode('frota.editar') ? botao('Novo veículo', () => editar(null, (v) => ir(`#/veiculos/${v.id}`)), { ic: 'mais' }) : null] }),
  el('div', { class: 'filtros' }, busca, status), corpo);
  function atualizar() {
    return carregar(corpo, () => api.get(`/frota/veiculos${qs(filtro)}`), (l) => painel(null, tabela([
      { titulo: 'Veículo', valor: (v) => el('div', {}, el('div', { class: 'forte' }, `${placa(v.placa)} · ${[v.marca, v.modelo].filter(Boolean).join(' ')}`), el('div', { class: 'fraco' }, [v.identificacao, v.ano, rotulo('combustivel', v.combustivel)].filter(Boolean).join(' · '))) },
      { titulo: 'Responsável', valor: (v) => v.responsavel?.nome ?? '—' },
      { titulo: 'Odômetro', valor: (v) => el('div', {}, km(v.odometro_km), v.odometro_em ? el('div', { class: 'fraco' }, `${v.odometro_fonte} · ${desde(v.odometro_em)}`) : null), classe: 'num' },
      { titulo: 'Situação', valor: (v) => el('div', {}, etqDe('statusVeiculo', v.status), v.restricoes.length ? el('div', { class: 'fraco' }, v.restricoes.map((r) => r.motivo).join('; ')) : null) },
    ], l.itens, { vazioTexto: 'Nenhum veículo cadastrado.', aoClicar: (v) => ir(`#/veiculos/${v.id}`), pagina: paginacao(l, (p) => { filtro.pagina = p; atualizar(); }) }), { semCorpo: true }));
  }
  atualizar();
}

function editar(v, depois) {
  return formulario(v ? 'Editar veículo' : 'Novo veículo', [
    { nome: 'placa', rotulo: 'Placa', obrigatorio: true, valor: v?.placa, ajuda: 'ABC1234 ou ABC1D23; única na organização.' },
    { nome: 'identificacao', rotulo: 'Identificação interna', valor: v?.identificacao },
    { nome: 'marca', rotulo: 'Marca', valor: v?.marca }, { nome: 'modelo', rotulo: 'Modelo', obrigatorio: true, valor: v?.modelo },
    { nome: 'ano', rotulo: 'Ano', tipo: 'number', valor: v?.ano },
    { nome: 'categoria', rotulo: 'Categoria', tipo: 'select', vazio: false, opcoes: opcoes('categoria'), valor: v?.categoria ?? 'utilitario' },
    { nome: 'combustivel', rotulo: 'Combustível', tipo: 'select', vazio: false, opcoes: opcoes('combustivel'), valor: v?.combustivel ?? 'flex' },
    { nome: 'tanque_litros', rotulo: 'Capacidade do tanque (L)', tipo: 'number', valor: v?.tanque_litros, ajuda: 'Opcional: sinaliza abastecimento incompatível.' },
    { nome: 'odometro_km', rotulo: 'Odômetro (km)', tipo: 'number', valor: v?.odometro_km },
    v ? { nome: 'motivo_odometro', rotulo: 'Motivo da correção do odômetro', ajuda: 'Obrigatório só para reduzir a leitura.' } : null,
    { nome: 'status_base', rotulo: 'Estado', tipo: 'select', vazio: false, valor: v?.status_base ?? 'disponivel',
      opcoes: [['disponivel', 'Disponível'], ['em_operacao', 'Em operação'], ['reservado', 'Reservado'], ['inativo', 'Inativo']] },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', valor: v?.observacoes, inteiro: true },
  ], { largo: true, enviar: async (d) => {
    const corpo = { ...d, ano: d.ano || null, tanque_litros: d.tanque_litros || null, odometro_km: d.odometro_km === '' ? undefined : d.odometro_km };
    const r = v ? await api.patch(`/frota/veiculos/${v.id}`, { ...corpo, versao: v.versao }) : await api.post('/frota/veiculos', corpo);
    toast('Veículo salvo.');
    depois?.(r);
    return r;
  } });
}

async function detalhe(alvo, id, ir) {
  const recarregar = () => detalhe(alvo, id, ir);
  limpar(alvo, carregando());
  let v;
  try { v = await api.get(`/frota/veiculos/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  const [tecnicos] = await Promise.all([pode('frota.escalar') ? api.get('/equipe/tecnicos?ativos=1').catch(() => []) : []]);
  const d = v.disponibilidade;
  limpar(alvo,
    el('a', { href: '#/veiculos', class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Veículos'),
    cabecalho({ sobretitulo: `${rotulo('categoria', v.categoria)} · ${rotulo('combustivel', v.combustivel)}`, titulo: `${placa(v.placa)} · ${[v.marca, v.modelo].filter(Boolean).join(' ')}`,
      descricao: v.identificacao ? `Identificação interna ${v.identificacao}` : null,
      acoes: [pode('frota.editar') ? botao('Editar', () => editar(v, recarregar), { tipo: 'secundario' }) : null,
        pode('frota.editar') ? botao('Bloquear', () => formulario('Bloquear veículo', [
          { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', obrigatorio: true, opcoes: ['oficina', 'documento', 'sinistro', 'administrativa'].map((t) => [t, rotulo('restricao', t)]) },
          { nome: 'motivo', rotulo: 'Motivo', obrigatorio: true, inteiro: true }], { enviar: async (x) => { await api.post(`/frota/veiculos/${v.id}/restricoes`, x); recarregar(); } }), { tipo: 'perigo' }) : null,
        pode('manutencao.editar') ? el('a', { class: 'botao', href: `#/manutencao?veiculo=${v.id}` }, icone('chave'), 'Manutenção') : null] }),
    d.disponivel ? null : faixa(`Fora da escala: ${d.motivos.map((m) => m.motivo).join('; ')}. A conclusão de um serviço só libera o veículo quando não resta outra restrição.`, 'erro', 'alerta'),
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel('Restrições ativas', d.motivos.length ? tabela([
          { titulo: 'Tipo', valor: (m) => rotulo('restricao', m.tipo) ?? m.tipo }, { titulo: 'Motivo', valor: (m) => m.motivo }, { titulo: 'Desde', valor: (m) => dataHora(m.desde) },
          { titulo: '', valor: (m) => (m.restricao_id && m.tipo !== 'manutencao' && pode('frota.editar') ? el('button', { class: 'botao secundario pequeno', onclick: () => pedirMotivo('Liberar veículo', 'Motivo da liberação',
            async (t) => { await api.post(`/frota/restricoes/${m.restricao_id}/liberar`, { motivo: t }); toast('Restrição liberada.'); recarregar(); }) }, 'Liberar')
            : m.tipo === 'manutencao' ? el('span', { class: 'fraco' }, 'Libera ao concluir a ordem') : '') },
        ], d.motivos) : vazio('Nenhuma restrição ativa.', 'Disponível para escala.')),
        painel('Manutenção e lavagem', tabela([
          { titulo: 'Serviço', valor: (m) => el('div', {}, el('div', { class: 'forte' }, m.descricao), el('div', { class: 'fraco' }, [rotulo('tipoManutencao', m.tipo), m.fornecedor].filter(Boolean).join(' · '))) },
          { titulo: 'Data', valor: (m) => data(m.concluido_em ?? m.data_planejada) }, { titulo: 'Orçado', valor: (m) => dinheiro(m.custo_previsto_centavos), classe: 'num' },
          { titulo: 'Realizado', valor: (m) => dinheiro(m.custo_realizado_centavos), classe: 'num' }, { titulo: 'Situação', valor: (m) => etqDe('statusManutencao', m.status) },
        ], v.manutencoes, { vazioTexto: 'Nenhuma ordem registrada.', aoClicar: () => ir(`#/manutencao?veiculo=${v.id}`) }), { semCorpo: true }),
        painel('Abastecimentos recentes', tabela([
          { titulo: 'Data', valor: (a) => dataHora(a.data_hora) }, { titulo: 'Odômetro', valor: (a) => km(a.odometro_km), classe: 'num' },
          { titulo: 'Volume', valor: (a) => litros(a.litros_ml), classe: 'num' }, { titulo: 'Total', valor: (a) => dinheiro(a.total_centavos), classe: 'num' },
          { titulo: 'Tanque', valor: (a) => (a.tanque_cheio ? 'Cheio' : 'Parcial') },
        ], v.abastecimentos, { vazioTexto: 'Nenhum abastecimento.' }), { semCorpo: true }),
        painel('Chamados relacionados', tabela([{ titulo: 'Chamado', valor: (c) => `#${c.numero} ${c.titulo}` }, { titulo: 'Agenda', valor: (c) => dataHora(c.agendado_para) },
          { titulo: 'Situação', valor: (c) => etqDe('statusChamado', c.status) }], v.chamados, { vazioTexto: 'Nenhum chamado com este veículo.', aoClicar: (c) => ir(`#/chamados/${c.id}`) }), { semCorpo: true })),
      el('div', {},
        painel('Dados', dl([['Situação', etqDe('statusVeiculo', v.status)], ['Odômetro', km(v.odometro_km)], ['Fonte do odômetro', v.odometro_fonte ? `${v.odometro_fonte} · ${dataHora(v.odometro_em)}` : 'Sem leitura'],
          ['Ano', v.ano], ['Tanque', v.tanque_litros ? `${v.tanque_litros} L` : 'Não informado'],
          ['Rastreador', v.dispositivo ? `${v.dispositivo.dispositivo_id} (desde ${data(v.dispositivo.inicio)})` : 'Sem dispositivo vinculado'], ['Observações', v.observacoes]])),
        painel('Responsável', el('div', {},
          dl([['Atual', v.responsavel ? `${v.responsavel.nome} desde ${dataHora(v.responsavel.desde)}` : 'Sem responsável']]),
          pode('frota.escalar') ? el('div', { class: 'form-acoes', style: 'justify-content:flex-start' }, botao('Definir responsável', () => formulario('Responsável pelo veículo', [
            { nome: 'tecnico_id', rotulo: 'Técnico', tipo: 'select', vazio: 'Nenhum (encerrar vínculo)', opcoes: tecnicos.map((t) => [t.id, t.nome]) }, { nome: 'motivo', rotulo: 'Motivo', inteiro: true },
          ], { enviar: async (x) => { await api.post(`/frota/veiculos/${v.id}/responsavel`, { tecnico_id: x.tecnico_id || null, motivo: x.motivo }); toast('Responsável atualizado.'); recarregar(); } }),
          { tipo: 'secundario pequeno' })) : null,
          v.historico_responsaveis.length ? el('ul', { class: 'linha-tempo', style: 'margin-top:12px' }, v.historico_responsaveis.map((h) => el('li', {}, h.tecnico_nome,
            el('small', {}, `${dataHora(h.inicio)} → ${h.fim ? dataHora(h.fim) : 'atual'}${h.motivo ? ` · ${h.motivo}` : ''}`)))) : null)),
        pode('frota.documentos') ? painel('Documentos', el('div', {},
          v.documentos.length ? el('ul', { class: 'linha-tempo' }, v.documentos.map((doc) => el('li', {}, el('strong', {}, rotulo('documento', doc.tipo)), doc.numero ? ` ${doc.numero}` : '',
            el('small', {}, doc.vencimento ? `Vence em ${data(doc.vencimento)}` : 'Sem vencimento'),
            doc.anexos.map((a) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); acao(null, () => abrirAnexo(a.id)); } }, icone('arquivo'), a.nome))))) : el('p', { class: 'fraco' }, 'Nenhum documento.'),
          el('div', { class: 'form-acoes', style: 'justify-content:flex-start' }, botao('Adicionar documento', () => formulario('Documento do veículo', [
            { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', obrigatorio: true, opcoes: opcoes('documento') }, { nome: 'numero', rotulo: 'Número' },
            { nome: 'vencimento', rotulo: 'Vencimento', tipo: 'date' }, { nome: 'arquivo', rotulo: 'Arquivo', tipo: 'file' }, { nome: 'observacoes', rotulo: 'Observações', inteiro: true },
          ], { enviar: async (x) => {
            const a = x.arquivo ? await api.enviarArquivo('veiculo_documento', null, x.arquivo) : null;
            await api.post(`/frota/veiculos/${v.id}/documentos`, { ...x, arquivo: undefined, anexo_id: a?.id });
            toast('Documento salvo.');
            recarregar();
          } }), { tipo: 'secundario pequeno' })))) : null,
        painel('Histórico de restrições', v.historico_restricoes.length ? el('ul', { class: 'linha-tempo' }, v.historico_restricoes.map((r) => el('li', {}, `${rotulo('restricao', r.tipo)}: ${r.motivo}`,
          el('small', {}, `${dataHora(r.inicio)} → ${r.fim ? `${dataHora(r.fim)} · ${r.liberado_por_nome ?? 'sistema'}${r.motivo_liberacao ? ` · ${r.motivo_liberacao}` : ''}` : 'ativa'}`)))) : el('p', { class: 'fraco' }, 'Sem histórico.')))));
}
