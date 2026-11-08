import { api, qs } from '../api.js';
import { el, limpar, pode, usuario, cabecalho, painel, tabela, paginacao, abas, etq, etqDe, rotulo, opcoes, dataHora, data, hoje, dl, toast, carregar, formulario,
  pedirMotivo, botao, faixa, dinheiro, duracaoMin, modal } from '../ui.js';

export default async function equipe({ alvo, query }) {
  const ehTecnico = usuario().perfil === 'tecnico';
  const lista = [
    pode('equipe.ver') ? ['tecnicos', 'Técnicos'] : null, pode('equipe.ver') ? ['produtividade', 'Produtividade'] : null,
    pode('comissoes.ver') ? ['comissoes', ehTecnico ? 'Minhas comissões' : 'Conferência'] : null, pode('comissoes.ver') ? ['regras', 'Regras'] : null,
    pode('comissoes.pagar') ? ['pagamentos', 'Pagamentos registrados'] : null,
  ].filter(Boolean);
  let aba = lista.some(([id]) => id === query.aba) ? query.aba : lista[0][0];
  const corpo = el('div');
  const barra = el('div');
  const trocar = (id) => { aba = id; barra.replaceChildren(abas(lista, aba, trocar)); desenhar(); };
  limpar(alvo, cabecalho({ sobretitulo: 'Equipe de campo', titulo: 'Equipe e comissões',
    descricao: 'Produtividade por período e comissões rastreáveis: regra versionada, aprovação por perfil autorizado e registro administrativo do pagamento.' }), barra, corpo);
  const TELAS = { tecnicos, produtividade, comissoes, regras, pagamentos };
  const desenhar = () => TELAS[aba](corpo);
  trocar(aba);
}

async function tecnicos(corpo) {
  const editar = (t = {}) => api.get('/organizacao/usuarios').catch(() => []).then((us) => formulario(t.id ? 'Editar técnico' : 'Novo técnico', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: t.nome, inteiro: true },
    { nome: 'usuario_id', rotulo: 'Usuário de acesso (perfil Técnico)', tipo: 'select', vazio: 'Sem acesso ao sistema', valor: t.usuario_id,
      opcoes: us.filter((u) => u.perfil === 'tecnico').map((u) => [u.id, `${u.nome} · ${u.email}`]), ajuda: 'Com usuário, o técnico vê e executa os próprios chamados.' },
    { nome: 'status', rotulo: 'Situação', tipo: 'select', vazio: false, valor: t.status ?? 'ativo', opcoes: [['ativo', 'Ativo'], ['afastado', 'Afastado'], ['inativo', 'Inativo']] },
    { nome: 'especialidades', rotulo: 'Especialidades', valor: t.especialidades }, { nome: 'regioes', rotulo: 'Regiões / bairros', valor: t.regioes },
    { nome: 'equipe', rotulo: 'Equipe', valor: t.equipe }, { nome: 'telefone', rotulo: 'Telefone operacional', valor: t.telefone },
  ], { enviar: async (d) => { await (t.id ? api.patch(`/equipe/tecnicos/${t.id}`, { ...d, usuario_id: d.usuario_id || null }) : api.post('/equipe/tecnicos', { ...d, usuario_id: d.usuario_id || null }));
    toast('Técnico salvo.'); tecnicos(corpo); } }));
  await carregar(corpo, () => api.get('/equipe/tecnicos'), (l) => painel('Técnicos', tabela([
    { titulo: 'Nome', valor: (t) => el('div', {}, el('div', { class: 'forte' }, t.nome), el('div', { class: 'fraco' }, t.usuario_email ?? 'Sem acesso ao sistema')) },
    { titulo: 'Especialidades', valor: (t) => t.especialidades ?? '—' }, { titulo: 'Regiões', valor: (t) => t.regioes ?? '—' },
    { titulo: 'Veículo', valor: (t) => t.veiculo_placa ?? '—' }, { titulo: 'Chamados ativos', valor: (t) => t.chamados_ativos, classe: 'num' },
    { titulo: 'Situação', valor: (t) => etq({ ativo: 'Ativo', afastado: 'Afastado', inativo: 'Inativo' }[t.status], t.status === 'ativo' ? 'ok' : 'neutra') },
  ], l, { vazioTexto: 'Nenhum técnico cadastrado.', aoClicar: pode('equipe.editar') ? editar : null }),
  { acoes: [pode('equipe.editar') ? botao('Novo técnico', () => editar(), { ic: 'mais' }) : null] }));
}

async function produtividade(corpo) {
  const de = el('input', { type: 'date', value: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10), 'aria-label': 'De' });
  const ate = el('input', { type: 'date', value: hoje(), 'aria-label': 'Até' });
  const area = el('div');
  const atualizar = () => carregar(area, () => api.get(`/equipe/produtividade${qs({ de: de.value, ate: ate.value })}`), (p) => painel(`Período ${data(p.de)} a ${data(p.ate)}`, tabela([
    { titulo: 'Técnico', valor: (t) => t.nome }, { titulo: 'Concluídos', valor: (t) => t.concluidos ?? 0, classe: 'num' }, { titulo: 'Aprovados', valor: (t) => t.aprovados ?? 0, classe: 'num' },
    { titulo: 'Tempo médio', valor: (t) => duracaoMin(t.minutos_medios), classe: 'num' },
    { titulo: 'No prazo', valor: (t) => (t.cumprimento_prazo === null ? '—' : `${t.cumprimento_prazo.toLocaleString('pt-BR')}%`), classe: 'num' },
    { titulo: 'Retrabalho', valor: (t) => t.retrabalho ?? 0, classe: 'num' },
  ], p.tecnicos), { rodape: [el('span', {}, `Fonte: ${p.fonte}`), el('span', {}, 'Tempo médio: do início da execução à conclusão técnica')] }));
  de.addEventListener('change', atualizar);
  ate.addEventListener('change', atualizar);
  limpar(corpo, el('div', { class: 'filtros' }, el('label', { class: 'campo' }, el('span', {}, 'De'), de), el('label', { class: 'campo' }, el('span', {}, 'Até'), ate)), area);
  atualizar();
}

async function comissoes(corpo, filtro = { status: pode('comissoes.aprovar') ? 'aguardando_aprovacao' : '', pagina: 1 }) {
  const sel = el('select', { 'aria-label': 'Situação' }, el('option', { value: '' }, 'Todas'), opcoes('statusComissao').map(([v, r]) => el('option', { value: v, selected: v === filtro.status }, r)));
  sel.addEventListener('change', () => comissoes(corpo, { ...filtro, status: sel.value, pagina: 1 }));
  const selecionadas = new Set();
  const area = el('div');
  limpar(corpo, el('div', { class: 'filtros' }, sel,
    pode('comissoes.pagar') ? botao('Registrar pagamento das selecionadas', () => registrarPagamento([...selecionadas], () => comissoes(corpo, filtro)), { tipo: 'secundario', ic: 'dinheiro' }) : null), area);
  await carregar(area, () => api.get(`/equipe/comissoes${qs(filtro)}`), (l) => el('div', {},
    l.totais.length ? el('div', { class: 'stats' }, l.totais.map((t) => el('div', { class: 'stat' }, el('div', { class: 'rotulo' }, rotulo('statusComissao', t.status)),
      el('div', { class: 'valor', style: 'font-size:24px' }, dinheiro(t.total_centavos)), el('div', { class: 'nota neutra' }, `${t.quantidade} comissão(ões)`)))) : null,
    painel(null, tabela([
      pode('comissoes.pagar') ? { titulo: '', valor: (c) => (c.status === 'aprovada' ? el('input', { type: 'checkbox', 'aria-label': `Selecionar comissão ${c.id}`,
        onclick: (e) => e.stopPropagation(), onchange: (e) => (e.target.checked ? selecionadas.add(c.id) : selecionadas.delete(c.id)) }) : '') } : null,
      { titulo: 'Chamado', valor: (c) => el('div', {}, el('a', { href: `#/chamados/${c.chamado_id}`, onclick: (e) => e.stopPropagation() }, `#${c.chamado_numero} ${c.chamado_titulo}`),
        el('div', { class: 'fraco' }, c.base)) },
      { titulo: 'Técnico', valor: (c) => el('div', {}, c.tecnico_nome, c.percentual_rateio < 100 ? el('div', { class: 'fraco' }, `Rateio ${c.percentual_rateio}%`) : null) },
      { titulo: 'Regra', valor: (c) => `v${c.regra_versao}` }, { titulo: 'Valor', valor: (c) => dinheiro(c.valor_centavos), classe: 'num' },
      { titulo: 'Saldo', valor: (c) => dinheiro(c.saldo_centavos), classe: 'num' }, { titulo: 'Situação', valor: (c) => etqDe('statusComissao', c.status) },
    ].filter(Boolean), l.itens, { vazioTexto: 'Nenhuma comissão nesta situação.', aoClicar: (c) => detalheComissao(c.id, () => comissoes(corpo, filtro)),
      pagina: paginacao(l, (p) => comissoes(corpo, { ...filtro, pagina: p })) }), { semCorpo: true })));
}

async function detalheComissao(id, recarregar) {
  const c = await api.get(`/equipe/comissoes/${id}`);
  const proprio = c.tecnico_usuario_id === usuario().id;
  modal(`Comissão #${c.id}`, (fechar) => {
    const feito = () => { fechar(); recarregar(); };
    return [
      proprio ? faixa('Esta comissão é sua: a aprovação e os ajustes cabem a outra pessoa autorizada.', 'info') : null,
      dl([['Situação', etqDe('statusComissao', c.status)], ['Base', c.base], ['Regra', `v${c.versao.versao} · ${c.versao.modo === 'fixo' ? 'valor fixo' : `por unidade (${c.versao.campo_unidade})`} · ${dinheiro(c.versao.valor_centavos)}`],
        ['Valor original', dinheiro(c.valor_centavos)], ['Saldo', dinheiro(c.saldo_centavos)], ['Moeda', c.moeda],
        c.pagamento ? ['Pagamento registrado', `${data(c.pagamento.data_pagamento)} · ${c.pagamento.referencia} · ${dinheiro(c.pagamento.valor_item)}`] : null]),
      c.ajustes.length ? el('div', { style: 'margin-top:14px' }, el('strong', {}, 'Ajustes'), el('ul', { class: 'linha-tempo', style: 'margin-top:8px' }, c.ajustes.map((a) => el('li', {}, `${dinheiro(a.valor_centavos)} — ${a.motivo}`,
        el('small', {}, `${dataHora(a.criado_em)} · ${a.criado_por_nome}`))))) : null,
      el('div', { style: 'margin-top:14px' }, el('strong', {}, 'Histórico'), el('ul', { class: 'linha-tempo', style: 'margin-top:8px' }, c.eventos.map((e) => el('li', {}, `${rotulo('statusComissao', e.para)}${e.motivo ? ` — ${e.motivo}` : ''}`,
        el('small', {}, `${dataHora(e.em)} · ${e.usuario_nome ?? 'Sistema'}`))))),
      !proprio && pode('comissoes.aprovar') ? el('div', { class: 'form-acoes' },
        c.status === 'aguardando_aprovacao' ? botao('Aprovar', async () => { await api.post(`/equipe/comissoes/${c.id}/aprovar`, {}); toast('Comissão aprovada.'); feito(); }, { ic: 'ok' }) : null,
        ['aguardando_aprovacao', 'suspensa'].includes(c.status) ? botao('Rejeitar', () => pedirMotivo('Rejeitar comissão', 'Motivo', async (m) => { await api.post(`/equipe/comissoes/${c.id}/rejeitar`, { motivo: m }); feito(); }), { tipo: 'perigo' }) : null,
        ['aprovada', 'paga', 'suspensa'].includes(c.status) ? botao('Ajuste / estorno', () => formulario('Ajuste da comissão', [
          { nome: 'valor', rotulo: 'Valor (negativo para estorno)', tipo: 'decimal', obrigatorio: true, placeholder: '-35,00' }, { nome: 'motivo', rotulo: 'Motivo', obrigatorio: true, inteiro: true },
        ], { enviar: async (d) => { await api.post(`/equipe/comissoes/${c.id}/ajustes`, d); toast('Ajuste registrado.'); feito(); } }), { tipo: 'secundario' }) : null) : null,
    ];
  }, { largo: true });
}

async function registrarPagamento(ids, recarregar) {
  if (!ids.length) { toast('Selecione comissões aprovadas na lista.', true); return; }
  return formulario('Registrar pagamento', [
    { nome: 'data_pagamento', rotulo: 'Data do pagamento', tipo: 'date', obrigatorio: true, valor: hoje() },
    { nome: 'referencia', rotulo: 'Referência (nº do comprovante, PIX…)', obrigatorio: true },
    { nome: 'comprovante', rotulo: 'Comprovante', tipo: 'file', inteiro: true },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true },
  ], { rotuloEnviar: 'Registrar', antes: faixa(`Registro administrativo de ${ids.length} comissão(ões) aprovada(s). Nenhuma transferência bancária é feita pelo sistema.`, 'info'),
    enviar: async (d) => {
      const comprovante = d.comprovante ? await api.enviarArquivo('comissao_pagamento', null, d.comprovante) : null;
      const r = await api.post('/equipe/pagamentos', { comissao_ids: ids, data_pagamento: d.data_pagamento, referencia: d.referencia, observacoes: d.observacoes, comprovante_id: comprovante?.id });
      toast(`${r.aviso} Total ${dinheiro(r.valor_centavos)}.`);
      recarregar();
    } });
}

async function regras(corpo) {
  const nova = () => formulario('Regra de comissão', [
    { nome: 'tipo_servico', rotulo: 'Tipo de serviço', tipo: 'select', obrigatorio: true, opcoes: opcoes('tipoChamado') },
    { nome: 'nome', rotulo: 'Nome da regra' },
    { nome: 'modo', rotulo: 'Cálculo', tipo: 'select', vazio: false, opcoes: [['fixo', 'Valor fixo por serviço'], ['por_unidade', 'Valor × quantidade de um item do checklist']] },
    { nome: 'valor', rotulo: 'Valor (R$)', tipo: 'decimal', obrigatorio: true },
    { nome: 'campo_unidade', rotulo: 'Item do checklist com a quantidade', ajuda: 'Só para "por quantidade". Ex.: fibras_fundidas', inteiro: true },
  ], { antes: faixa('Salvar cria uma nova versão. Ela vale para aprovações futuras; comissões já geradas mantêm a versão e o valor.', 'info'),
    enviar: async (d) => { await api.post('/equipe/regras', d); toast('Versão da regra criada.'); regras(corpo); } });
  await carregar(corpo, () => api.get('/equipe/regras'), (l) => painel('Regras por tipo de serviço', tabela([
    { titulo: 'Tipo', valor: (x) => rotulo('tipoChamado', x.tipo_servico) }, { titulo: 'Regra', valor: (x) => x.nome },
    { titulo: 'Vigente', valor: (x) => (x.vigente ? `v${x.vigente.versao} · ${x.vigente.modo === 'fixo' ? dinheiro(x.vigente.valor_centavos) : `${dinheiro(x.vigente.valor_centavos)} × ${x.vigente.campo_unidade}`}` : 'Sem versão vigente') },
    { titulo: 'Histórico', valor: (x) => x.versoes.map((v) => `v${v.versao} ${dinheiro(v.valor_centavos)} (${data(v.vigente_desde)})`).join(' · ') },
    { titulo: 'Situação', valor: (x) => (x.ativa ? etq('Ativa', 'ok') : etq('Desativada', 'neutra')) },
  ], l, { vazioTexto: 'Nenhuma regra: sem regra, a aprovação do chamado não gera comissão.' }), { acoes: [pode('comissoes.regras') ? botao('Nova versão', nova, { ic: 'mais' }) : null] }));
}

async function pagamentos(corpo) {
  await carregar(corpo, () => api.get('/equipe/pagamentos'), (l) => el('div', {}, faixa('Registros administrativos de pagamento. O sistema não executa transferências bancárias.', 'info'), painel(null, tabela([
    { titulo: 'Data', valor: (p) => data(p.data_pagamento) }, { titulo: 'Referência', valor: (p) => p.referencia }, { titulo: 'Comissões', valor: (p) => p.comissoes, classe: 'num' },
    { titulo: 'Valor', valor: (p) => dinheiro(p.valor_centavos), classe: 'num' }, { titulo: 'Comprovante', valor: (p) => (p.comprovantes ? 'Anexado' : '—') },
    { titulo: 'Registrado por', valor: (p) => `${p.registrado_por_nome} · ${dataHora(p.criado_em)}` },
  ], l.itens, { vazioTexto: 'Nenhum pagamento registrado.' }), { semCorpo: true })));
}
