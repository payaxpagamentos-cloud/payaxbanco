import { api, qs, baixar } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, paginacao, abas, etqDe, rotulo, opcoes, dinheiro, data, dataHora, dl, competencia, documento,
  telefone, numero, carregar, carregando, formulario, pedirMotivo, botao, toast, faixa, stat, vazio, hoje } from '../ui.js';

export default async function faturamento({ alvo, params, query, ir }) {
  if (params[0]) return detalhe(alvo, Number(params[0]), ir);
  const aba = query.aba ?? 'faturas';
  const corpo = el('div');
  limpar(alvo, cabecalho({
    sobretitulo: 'Assinantes e financeiro',
    titulo: 'Faturamento',
    descricao: 'O ciclo mensal pode ser simulado quantas vezes quiser antes de emitir. Depois de efetivada, a competência não roda de novo.',
    acoes: [
      pode('faturamento.faturar') ? botao('Rodar o ciclo', () => rodarCiclo(() => faturamento({ alvo, params, query, ir })), { ic: 'atualizar' }) : null,
      pode('faturamento.faturar') ? botao('Cobrança avulsa', () => cobrancaAvulsa((f) => ir(`#/faturamento/${f.id}`)), { tipo: 'secundario', ic: 'mais' }) : null,
    ],
  }), abas([['faturas', 'Faturas'], ['painel', 'Painel do mês'], ['ciclos', 'Ciclos emitidos']], aba, (id) => ir(`#/faturamento?aba=${id}`)), corpo);

  if (aba === 'painel') return carregar(corpo, () => api.get('/faturamento/resumo'), desenharPainel);
  if (aba === 'ciclos') return carregar(corpo, () => api.get('/faturamento/ciclos'), desenharCiclos);
  return listaFaturas(corpo, query, ir);
}

function desenharPainel(r) {
  const contratos = r.contratos ?? {};
  return [
    el('div', { class: 'stats' },
      stat({ rotulo: `Faturado em ${competencia(r.competencia)}`, valor: dinheiro(r.faturado_mes.valor_centavos), nota: `${numero(r.faturado_mes.faturas)} fatura(s) emitida(s)`,
        ic: 'recibo', semDado: !r.faturado_mes.faturas }),
      stat({ rotulo: 'Recebido no mês', valor: dinheiro(r.recebido_mes.valor_centavos), nota: `${numero(r.recebido_mes.pagamentos)} baixa(s), com encargos`, ic: 'dinheiro' }),
      stat({ rotulo: 'A receber', valor: dinheiro(r.a_receber.valor_centavos), nota: `${numero(r.a_receber.faturas)} fatura(s) em aberto`, ic: 'relogio' }),
      stat({ rotulo: 'Vencido', valor: dinheiro(r.vencido.saldo_centavos), nota: r.vencido.faturas ? `${numero(r.vencido.faturas)} fatura(s) · devido ${dinheiro(r.vencido.devido_centavos)}` : 'Nada vencido',
        notaTipo: r.vencido.faturas ? 'erro' : 'ok', ic: 'alerta' })),
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel(`Ciclo de ${competencia(r.competencia)}`, r.ciclo_atual
          ? dl([['Emitido em', dataHora(r.ciclo_atual.criado_em)], ['Faturas', numero(r.ciclo_atual.faturas)],
            ['Valor', dinheiro(r.ciclo_atual.valor_centavos)], ['Contratos fora do ciclo', numero(JSON.parse(r.ciclo_atual.pulados ?? '[]').length)]])
          : vazio('A competência atual ainda não foi faturada.', 'Rode a simulação para conferir o que será emitido.')),
        painel('Receita recorrente', dl([
          ['Mensalidades dos contratos que faturam', dinheiro(r.mrr_centavos)],
          ['Contratos ativos', numero(contratos.ativo ?? 0)],
          ['Bloqueados por inadimplência (continuam faturando)', numero(contratos.bloqueado ?? 0)],
          ['Suspensos a pedido (fora do faturamento)', numero(contratos.suspenso ?? 0)],
          ['Em implantação', numero(contratos.em_implantacao ?? 0)],
          ['Cancelados', numero(contratos.cancelado ?? 0)],
        ]))),
      el('div', {},
        painel('Próximos dias', dl([['Vencem em até 7 dias', `${numero(r.vence_em_7)} fatura(s)`], ['Hoje', data(r.hoje)]])),
        painel('Assinantes', dl(Object.entries(r.assinantes ?? {}).map(([k, n]) => [rotulo('situacaoAssinante', k), numero(n)]))))),
  ];
}

function desenharCiclos(ciclos) {
  return painel(null, tabela([
    { titulo: 'Competência', valor: (c) => el('div', {}, el('div', { class: 'forte' }, competencia(c.competencia)),
      el('div', { class: 'fraco' }, `${dataHora(c.criado_em)} · ${c.executado_por_nome ?? 'sistema'}`)) },
    { titulo: 'Faturas', valor: (c) => numero(c.faturas), classe: 'num' },
    { titulo: 'Valor', valor: (c) => dinheiro(c.valor_centavos), classe: 'num' },
    { titulo: 'Fora do ciclo', valor: (c) => (c.pulados.length
      ? el('details', {}, el('summary', {}, `${c.pulados.length} contrato(s)`),
        el('ul', { class: 'linha-tempo', style: 'margin-top:8px' }, c.pulados.slice(0, 40).map((p) => el('li', {}, `#${p.numero} ${p.assinante}`, el('small', {}, p.motivo)))))
      : el('span', { class: 'fraco' }, 'Nenhum')) },
  ], ciclos, { vazioTexto: 'Nenhum ciclo emitido ainda.' }), { semCorpo: true });
}

function listaFaturas(corpo, query, ir) {
  const filtro = { busca: query.busca ?? '', situacao: query.situacao ?? '', competencia: query.competencia ?? '', pagina: 1 };
  const filtros = el('div', { class: 'filtros' });
  const busca = el('input', { type: 'search', class: 'busca', placeholder: 'Assinante, CPF/CNPJ ou número da fatura', value: filtro.busca, 'aria-label': 'Buscar faturas' });
  const situacao = el('select', { 'aria-label': 'Situação' }, el('option', { value: '' }, 'Todas as situações'),
    el('option', { value: 'vencida', selected: filtro.situacao === 'vencida' ? true : null }, 'Vencidas'),
    opcoes('situacaoFatura').map(([v, r]) => el('option', { value: v, selected: v === filtro.situacao ? true : null }, r)));
  const comp = el('input', { type: 'month', value: filtro.competencia, 'aria-label': 'Competência' });
  busca.addEventListener('input', () => { filtro.busca = busca.value; filtro.pagina = 1; clearTimeout(busca.t); busca.t = setTimeout(atualizar, 300); });
  situacao.addEventListener('change', () => { filtro.situacao = situacao.value; filtro.pagina = 1; atualizar(); });
  comp.addEventListener('change', () => { filtro.competencia = comp.value; filtro.pagina = 1; atualizar(); });
  filtros.append(busca, situacao, comp, botao('CSV', () => baixar(`/faturamento/faturas/csv/lista${qs({ situacao: filtro.situacao, competencia: filtro.competencia })}`, 'faturas.csv'),
    { tipo: 'secundario pequeno', ic: 'baixar' }));
  const lista = el('div');
  corpo.append(filtros, lista);

  function atualizar() {
    return carregar(lista, () => api.get(`/faturamento/faturas${qs(filtro)}`), (l) => painel(null, tabela([
      { titulo: 'Fatura', valor: (f) => el('div', {}, el('div', { class: 'forte' }, `#${f.numero} · ${f.assinante_nome}`),
        el('div', { class: 'fraco' }, [f.competencia ? competencia(f.competencia) : 'Avulsa', f.contrato_numero ? `contrato #${f.contrato_numero}` : null].filter(Boolean).join(' · '))) },
      { titulo: 'Vencimento', valor: (f) => el('div', {}, data(f.vencimento),
        f.encargos.dias_atraso ? el('div', { class: 'fraco' }, `${f.encargos.dias_atraso} dia(s) de atraso`) : null) },
      { titulo: 'Valor', valor: (f) => dinheiro(f.valor_centavos), classe: 'num' },
      { titulo: 'Pago', valor: (f) => (f.pago_centavos ? dinheiro(f.pago_centavos) : el('span', { class: 'fraco' }, '—')), classe: 'num' },
      { titulo: 'Devido hoje', valor: (f) => (f.encargos.total_devido_centavos
        ? el('div', {}, dinheiro(f.encargos.total_devido_centavos), f.encargos.multa_centavos
          ? el('div', { class: 'fraco' }, `+ ${dinheiro(f.encargos.multa_centavos + f.encargos.juros_centavos)} de encargos`) : null)
        : el('span', { class: 'fraco' }, '—')), classe: 'num' },
      { titulo: 'Situação', valor: (f) => etqDe('situacaoFatura', f.situacao) },
    ], l.itens, {
      vazioTexto: 'Nenhuma fatura com esse filtro.',
      aoClicar: (f) => ir(`#/faturamento/${f.id}`),
      pagina: paginacao(l, (p) => { filtro.pagina = p; atualizar(); }),
    }), { semCorpo: true }));
  }
  atualizar();
}

/** Simula a competência e só emite depois de o operador ver o que será cobrado. */
function rodarCiclo(depois) {
  return formulario('Rodar o ciclo mensal', [
    { nome: 'competencia', rotulo: 'Competência', tipo: 'month', obrigatorio: true, valor: hoje().slice(0, 7), inteiro: true,
      ajuda: 'O mês do serviço. O vencimento de cada fatura usa o dia escolhido no contrato.' },
  ], {
    rotuloEnviar: 'Simular',
    largo: true,
    antes: faixa('A simulação não grava nada e não consome número de fatura: pode ser repetida à vontade.', '', 'info'),
    enviar: async (d) => {
      const r = await api.post('/faturamento/ciclos', { competencia: d.competencia, simulacao: true });
      return conferirCiclo(r, d.competencia, depois);
    },
  });
}

function conferirCiclo(sim, comp, depois) {
  return formulario(`Conferir o ciclo de ${competencia(comp)}`, [], {
    rotuloEnviar: sim.faturas ? `Emitir ${sim.faturas} fatura(s)` : 'Fechar',
    largo: true,
    antes: el('div', {},
      el('div', { class: 'stats' },
        stat({ rotulo: 'Faturas a emitir', valor: numero(sim.faturas), ic: 'recibo' }),
        stat({ rotulo: 'Valor total', valor: dinheiro(sim.valor_centavos), ic: 'dinheiro' }),
        stat({ rotulo: 'Fora do ciclo', valor: numero(sim.pulados.length), nota: 'Com o motivo de cada um', ic: 'info' })),
      sim.faturas ? painel('O que será cobrado', tabela([
        { titulo: 'Contrato', valor: (p) => el('div', {}, el('div', { class: 'forte' }, `#${p.numero} ${p.assinante}`),
          el('div', { class: 'fraco' }, p.itens.map((i) => `${rotulo('origemItem', i.origem)} ${dinheiro(i.valor_centavos)}`).join(' · '))) },
        { titulo: 'Vencimento', valor: (p) => data(p.vencimento) },
        { titulo: 'Valor', valor: (p) => dinheiro(p.valor_centavos), classe: 'num' },
      ], sim.previsao ?? [], { vazioTexto: 'Nada a emitir.' }), { semCorpo: true }) : null,
      sim.pulados.length ? painel('Contratos fora do ciclo', el('ul', { class: 'linha-tempo' },
        sim.pulados.slice(0, 60).map((p) => el('li', {}, `#${p.numero} ${p.assinante}`, el('small', {}, p.motivo)))) ) : null),
    enviar: async () => {
      if (!sim.faturas) return true;
      const r = await api.post('/faturamento/ciclos', { competencia: comp });
      toast(`Ciclo de ${competencia(comp)} emitido: ${r.faturas} fatura(s), ${dinheiro(r.valor_centavos)}.`);
      depois?.();
      return r;
    },
  });
}

async function cobrancaAvulsa(depois) {
  const itens = [{ descricao: '', valor: '' }];
  const assinantes = (await api.get('/assinantes?por_pagina=200').catch(() => ({ itens: [] }))).itens ?? [];
  return formulario('Cobrança avulsa', [
    { nome: 'assinante_id', rotulo: 'Assinante', tipo: 'select', obrigatorio: true, inteiro: true,
      opcoes: assinantes.map((a) => [a.id, `${a.codigo} · ${a.nome} · ${documento(a.documento)}`]) },
    { nome: 'vencimento', rotulo: 'Vencimento', tipo: 'date', obrigatorio: true, valor: hoje() },
    { nome: 'descricao', rotulo: 'Descrição', obrigatorio: true, inteiro: true, ajuda: 'Ex.: visita técnica, material, multa de fidelidade.' },
    { nome: 'valor', rotulo: 'Valor (R$)', tipo: 'decimal', obrigatorio: true },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true },
  ], {
    largo: true,
    antes: faixa('A cobrança avulsa não pertence a competência nenhuma: não é tocada pelo ciclo mensal, mas entra na régua de cobrança como qualquer fatura.', '', 'info'),
    enviar: async (d) => {
      const r = await api.post('/faturamento/faturas', { assinante_id: d.assinante_id, vencimento: d.vencimento, observacoes: d.observacoes,
        itens: [{ descricao: d.descricao, valor: d.valor }] });
      toast(`Fatura #${r.numero} emitida.`);
      depois?.(r);
      return r;
    },
  });
}

async function detalhe(alvo, id, ir) {
  const recarregar = () => detalhe(alvo, id, ir);
  limpar(alvo, carregando());
  let f;
  try { f = await api.get(`/faturamento/faturas/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  const saldo = f.valor_centavos - f.pago_centavos;
  const emVigor = f.pagamentos.filter((p) => !p.estornado_em);

  const acoes = [];
  if (pode('faturamento.baixar') && !['paga', 'cancelada'].includes(f.situacao)) acoes.push(botao('Registrar baixa', () => baixa(f, recarregar), { ic: 'ok' }));
  if (pode('faturamento.estornar') && f.situacao !== 'cancelada') {
    acoes.push(botao('Cancelar fatura', () => pedirMotivo('Cancelar a fatura', 'Motivo do cancelamento', async (motivo) => {
      const r = await api.post(`/faturamento/faturas/${f.id}/cancelar`, { motivo });
      toast(r.aviso ?? 'Fatura cancelada.');
      recarregar();
    }, { ajuda: 'A fatura não é apagada: fica cancelada, com o motivo e quem cancelou.' }), { tipo: 'perigo' }));
  }

  limpar(alvo,
    el('a', { href: '#/faturamento', class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Faturamento'),
    cabecalho({
      sobretitulo: `Fatura #${f.numero} · ${f.competencia ? `competência ${competencia(f.competencia)}` : 'cobrança avulsa'}`,
      titulo: f.assinante_nome,
      descricao: [documento(f.assinante_documento), f.contrato_numero ? `contrato #${f.contrato_numero}` : null, f.plano_nome].filter(Boolean).join(' · '),
      acoes,
    }),
    f.situacao === 'cancelada' ? faixa(`Fatura cancelada em ${dataHora(f.cancelada_em)}: ${f.motivo_cancelamento}`, 'aviso', 'info') : null,
    f.encargos.dias_atraso && saldo > 0
      ? faixa(`${f.encargos.dias_atraso} dia(s) de atraso. Multa de ${dinheiro(f.encargos.multa_centavos)} e juros de ${dinheiro(f.encargos.juros_centavos)} calculados para hoje — o valor da fatura não muda.`, 'erro', 'alerta')
      : null,
    el('div', { class: 'stats' },
      stat({ rotulo: 'Valor da fatura', valor: dinheiro(f.valor_centavos), nota: `Vence em ${data(f.vencimento)}`, ic: 'recibo' }),
      stat({ rotulo: 'Pago', valor: dinheiro(f.pago_centavos), nota: f.pago_em ? `Quitada em ${data(f.pago_em)}` : `${emVigor.length} baixa(s) em vigor`, ic: 'ok' }),
      stat({ rotulo: 'Saldo', valor: dinheiro(saldo), nota: rotulo('situacaoFatura', f.situacao), ic: 'dinheiro', semDado: saldo === 0 }),
      stat({ rotulo: 'Total devido hoje', valor: dinheiro(f.encargos.total_devido_centavos), nota: 'Saldo com multa e juros', ic: 'alerta' })),
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel('Itens da fatura', tabela([
          // A referência é a rastreabilidade do item. Só vale mostrar quando acrescenta algo à descrição:
          // 'periodo:...' explica a proporcional; 'competencia:...' e 'contrato:...' só repetiriam o que já está escrito.
          { titulo: 'Item', valor: (i) => el('div', {}, el('div', { class: 'forte' }, i.descricao),
            el('div', { class: 'fraco' }, [rotulo('origemItem', i.origem), /^(competencia|contrato):/.test(i.referencia ?? '') ? null : i.referencia].filter(Boolean).join(' · '))) },
          { titulo: 'Valor', valor: (i) => el('span', { class: i.valor_centavos < 0 ? 'fraco' : '' }, dinheiro(i.valor_centavos)), classe: 'num' },
        ], f.itens, { vazioTexto: 'Sem itens.' }), { semCorpo: true, rodape: el('strong', {}, `Total: ${dinheiro(f.valor_centavos)}`) }),
        painel('Baixas', tabela([
          { titulo: 'Pagamento', valor: (p) => el('div', {}, el('div', { class: p.estornado_em ? 'fraco' : 'forte' }, `${dinheiro(p.valor_centavos)} · ${rotulo('formaPagamento', p.forma)}`),
            el('div', { class: 'fraco' }, [data(p.data), rotulo('origemPagamento', p.origem), p.criado_por_nome].filter(Boolean).join(' · '))) },
          { titulo: 'Encargos', valor: (p) => (p.juros_centavos || p.multa_centavos || p.desconto_centavos
            ? el('div', { class: 'fraco' }, [p.multa_centavos ? `multa ${dinheiro(p.multa_centavos)}` : null, p.juros_centavos ? `juros ${dinheiro(p.juros_centavos)}` : null,
              p.desconto_centavos ? `desconto ${dinheiro(p.desconto_centavos)}` : null].filter(Boolean).join(' · '))
            : el('span', { class: 'fraco' }, '—')), classe: 'num' },
          { titulo: 'Situação', valor: (p) => (p.estornado_em
            ? el('div', {}, etqDe('resultadoRegua', 'ignorada'), el('div', { class: 'fraco' }, `Estornado por ${p.estornado_por_nome ?? '—'}: ${p.motivo_estorno}`))
            : etqDe('situacaoFatura', 'paga')) },
          { titulo: '', valor: (p) => (pode('faturamento.estornar') && !p.estornado_em
            ? el('button', { class: 'botao secundario pequeno', onclick: () => pedirMotivo('Estornar a baixa', 'Motivo do estorno', async (motivo) => {
              const r = await api.post(`/faturamento/pagamentos/${p.id}/estornar`, { motivo });
              toast(r.aviso ?? 'Baixa estornada.');
              recarregar();
            }) }, 'Estornar')
            : '') },
        ], f.pagamentos, { vazioTexto: 'Nenhuma baixa registrada.' }), { semCorpo: true })),
      el('div', {},
        painel('Dados', dl([
          ['Assinante', el('a', { href: `#/assinantes/${f.assinante_id}` }, `${f.assinante_codigo} · ${f.assinante_nome}`)],
          ['Documento', documento(f.assinante_documento)],
          ['Telefone', telefone(f.assinante_telefone)],
          ['E-mail', f.assinante_email],
          f.contrato_id ? ['Contrato', el('a', { href: `#/contratos/${f.contrato_id}` }, `#${f.contrato_numero} · ${f.plano_nome}`)] : null,
          ['Competência', f.competencia ? competencia(f.competencia) : 'Cobrança avulsa'],
          ['Vencimento', data(f.vencimento)],
          ['Emitida em', dataHora(f.criado_em)],
          ['Observações', f.observacoes],
        ])),
        painel('Cobrança', f.cobranca.length
          ? el('ul', { class: 'linha-tempo' }, f.cobranca.map((ev) => el('li', {},
            el('strong', {}, ev.regra_nome), ` · ${rotulo('acaoRegua', ev.acao)}`,
            el('small', {}, `${dataHora(ev.executado_em)} · ${rotulo('resultadoRegua', ev.resultado)} · ${ev.dias_atraso} dia(s) · ${ev.detalhe ?? ''}`))))
          : el('p', { class: 'fraco' }, 'A régua ainda não alcançou esta fatura.')))));
}

/** Formulário de baixa, usado na tela de faturamento e na ficha do assinante. */
export function baixa(f, depois) {
  const saldo = f.valor_centavos - f.pago_centavos;
  const real = (c) => (c / 100).toFixed(2).replace('.', ',');
  return formulario(`Baixa da fatura #${f.numero}`, [
    { nome: 'valor', rotulo: 'Valor que abate a fatura (R$)', tipo: 'decimal', valor: real(saldo),
      ajuda: `Saldo de ${dinheiro(saldo)}. Um valor menor deixa a fatura como pagamento parcial.` },
    { nome: 'data', rotulo: 'Data do pagamento', tipo: 'date', valor: hoje() },
    { nome: 'forma', rotulo: 'Forma', tipo: 'select', obrigatorio: true, opcoes: opcoes('formaPagamento'), valor: 'pix' },
    { nome: 'multa', rotulo: 'Multa cobrada (R$)', tipo: 'decimal', valor: real(f.encargos.multa_centavos) },
    { nome: 'juros', rotulo: 'Juros cobrados (R$)', tipo: 'decimal', valor: real(f.encargos.juros_centavos) },
    { nome: 'desconto', rotulo: 'Desconto concedido (R$)', tipo: 'decimal', valor: '0,00' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true },
  ], {
    largo: true,
    antes: f.encargos.dias_atraso
      ? faixa(`Multa e juros vêm calculados para hoje (${f.encargos.dias_atraso} dia(s) de atraso) e podem ser ajustados. Eles são registrados na baixa e não alteram o valor da fatura.`, '', 'info')
      : null,
    enviar: async (d) => {
      const r = await api.post(`/faturamento/faturas/${f.id}/pagamentos`, d);
      toast(r.aviso ?? 'Baixa registrada.');
      depois?.();
      return r;
    },
  });
}
