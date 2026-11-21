import { api, qs } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, paginacao, etqDe, rotulo, opcoes, dinheiro, data, dataHora, dl, competencia, velocidade,
  carregar, carregando, formulario, pedirMotivo, confirmar, botao, toast, faixa, stat, hoje } from '../ui.js';

export default async function contratos({ alvo, params, query, ir }) {
  if (params[0]) return detalhe(alvo, Number(params[0]), ir);
  const filtro = { busca: query.busca ?? '', situacao: query.situacao ?? '', pagina: 1 };
  const corpo = el('div');
  const busca = el('input', { type: 'search', class: 'busca', placeholder: 'Assinante, CPF/CNPJ ou número do contrato', value: filtro.busca, 'aria-label': 'Buscar contratos' });
  const situacao = el('select', { 'aria-label': 'Situação' }, el('option', { value: '' }, 'Todas as situações'),
    opcoes('situacaoContrato').map(([v, r]) => el('option', { value: v, selected: v === filtro.situacao ? true : null }, r)));
  busca.addEventListener('input', () => { filtro.busca = busca.value; filtro.pagina = 1; clearTimeout(busca.t); busca.t = setTimeout(atualizar, 300); });
  situacao.addEventListener('change', () => { filtro.situacao = situacao.value; filtro.pagina = 1; atualizar(); });

  limpar(alvo, cabecalho({
    sobretitulo: 'Assinantes e financeiro',
    titulo: 'Contratos',
    descricao: 'Cada contrato é um serviço num endereço: é ele que fatura, que ocupa a porta na planta óptica e que bloqueia.',
  }), el('div', { class: 'filtros' }, busca, situacao), corpo);

  function atualizar() {
    return carregar(corpo, () => api.get(`/contratos${qs(filtro)}`), (l) => painel(null, tabela([
      { titulo: 'Contrato', valor: (c) => el('div', {}, el('div', { class: 'forte' }, `#${c.numero} · ${c.assinante_nome}`),
        el('div', { class: 'fraco' }, [`assinante ${c.assinante_codigo}`, c.plano_nome, velocidade(c.download_mbps, c.upload_mbps)].filter(Boolean).join(' · '))) },
      { titulo: 'Ponto', valor: (c) => (c.cto_codigo ? el('div', {}, c.cto_codigo, c.porta_numero ? el('div', { class: 'fraco' }, `porta ${c.porta_numero}`) : null)
        : el('span', { class: 'fraco' }, 'Sem ponto')) },
      { titulo: 'Mensalidade', valor: (c) => el('div', {}, dinheiro(c.mensalidade_centavos), el('div', { class: 'fraco' }, `vence dia ${c.dia_vencimento}`)), classe: 'num' },
      { titulo: 'Ativação', valor: (c) => data(c.ativacao) },
      { titulo: 'Situação', valor: (c) => etqDe('situacaoContrato', c.situacao) },
    ], l.itens, {
      vazioTexto: 'Nenhum contrato com esse filtro.',
      aoClicar: (c) => ir(`#/contratos/${c.id}`),
      pagina: paginacao(l, (p) => { filtro.pagina = p; atualizar(); }),
    }), { semCorpo: true }));
  }
  atualizar();
}

async function detalhe(alvo, id, ir) {
  const recarregar = () => detalhe(alvo, id, ir);
  limpar(alvo, carregando());
  let c;
  try { c = await api.get(`/contratos/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  const planos = pode('contratos.editar') ? await api.get('/planos?ativos=1').catch(() => []) : [];
  const chamar = async (caminho, corpo, mensagem) => {
    const r = await api.post(`/contratos/${c.id}${caminho}`, corpo);
    toast(r.aviso ?? mensagem);
    recarregar();
    return r;
  };
  const cobranca = async (caminho, corpo, mensagem) => {
    const r = await api.post(`/cobranca/contratos/${c.id}${caminho}`, corpo);
    toast(r.aviso ?? mensagem);
    recarregar();
    return r;
  };

  const acoes = [];
  if (pode('contratos.ciclo')) {
    if (c.situacao === 'em_implantacao') {
      acoes.push(botao('Ativar serviço', () => formulario('Ativar o serviço', [
        { nome: 'ativacao', rotulo: 'Data da ativação', tipo: 'date', valor: hoje(), obrigatorio: true, ajuda: 'A primeira fatura é proporcional a partir deste dia.' },
        { nome: 'porta_id', rotulo: 'ID da porta na CTO', tipo: 'number', valor: c.porta_id, ajuda: 'A porta passa a ocupada na planta óptica.' },
      ], { enviar: (d) => chamar('/ativar', { ...d, porta_id: d.porta_id || undefined }, 'Serviço ativado.') }), { ic: 'ok' }));
    }
    if (c.situacao === 'ativo') acoes.push(botao('Suspender a pedido', () => pedirMotivo('Suspender a pedido do assinante', 'Motivo da suspensão',
      (motivo) => chamar('/suspender', { motivo }, 'Contrato suspenso.'), { ajuda: 'Enquanto suspenso, o contrato não entra no faturamento mensal.' }), { tipo: 'secundario' }));
    if (c.situacao === 'suspenso') acoes.push(botao('Reativar', () => chamar('/reativar', {}, 'Contrato reativado.'), { tipo: 'secundario', ic: 'atualizar' }));
  }
  if (pode('bloqueios.aplicar') && ['ativo', 'suspenso'].includes(c.situacao)) {
    acoes.push(botao('Bloquear', () => formulario('Bloquear o serviço', [
      { nome: 'tipo', rotulo: 'Motivo do bloqueio', tipo: 'select', obrigatorio: true, opcoes: opcoes('tipoBloqueio') },
      { nome: 'motivo', rotulo: 'Detalhe', obrigatorio: true, inteiro: true },
    ], { enviar: (d) => cobranca('/bloquear', d, 'Serviço bloqueado.') }), { tipo: 'perigo', ic: 'cadeado' }));
  }
  if (pode('bloqueios.liberar') && c.situacao === 'bloqueado') {
    acoes.push(botao('Desbloquear', () => pedirMotivo('Liberar o serviço', 'Motivo da liberação',
      (motivo) => cobranca('/desbloquear', { motivo }, 'Serviço liberado.')), { ic: 'ok' }));
    if (c.bloqueio?.tipo === 'inadimplencia' && !c.confianca) {
      acoes.push(botao('Desbloqueio de confiança', () => formulario('Desbloqueio de confiança', [
        { nome: 'dias', rotulo: 'Dias de prazo', tipo: 'number', valor: '', ajuda: 'Em branco usa o prazo padrão da operação.' },
        { nome: 'motivo', rotulo: 'Motivo', inteiro: true },
      ], {
        antes: faixa(`Este contrato usou ${c.confiancas_no_ano} desbloqueio(s) de confiança neste ano. Terminado o prazo sem pagamento, a rotina bloqueia de novo sozinha.`, '', 'info'),
        enviar: (d) => cobranca('/confianca', { ...d, dias: d.dias || undefined }, 'Serviço liberado por confiança.'),
      }), { tipo: 'secundario', ic: 'relogio' }));
    }
  }
  if (pode('contratos.editar') && c.situacao !== 'cancelado') acoes.push(botao('Editar', () => editar(c, planos, recarregar), { tipo: 'secundario' }));
  if (pode('contratos.ciclo') && c.situacao !== 'cancelado') {
    acoes.push(botao('Cancelar contrato', () => cancelar(c, recarregar), { tipo: 'perigo' }));
  }

  const avisos = [];
  if (c.bloqueio) {
    avisos.push(faixa(`Serviço bloqueado desde ${dataHora(c.bloqueio.inicio)} · ${rotulo('tipoBloqueio', c.bloqueio.tipo)} · ${rotulo('origemAcao', c.bloqueio.origem)}: ${c.bloqueio.motivo}`, 'erro', 'cadeado'));
  }
  if (c.confianca) {
    avisos.push(faixa(`Desbloqueio de confiança em vigor até ${data(c.confianca.ate)}. Sem pagamento até lá, a rotina bloqueia de novo.`, 'aviso', 'relogio'));
  }
  if (c.situacao === 'bloqueado') avisos.push(faixa('Contrato bloqueado por inadimplência continua faturando todo mês: o serviço está cortado, o contrato não.', '', 'info'));
  if (c.situacao === 'suspenso') avisos.push(faixa('Contrato suspenso a pedido: fora do faturamento mensal enquanto estiver assim.', 'aviso', 'info'));
  if (c.fidelidade_fim && c.fidelidade_fim > hoje() && c.situacao !== 'cancelado') {
    avisos.push(faixa(`Fidelidade de ${c.fidelidade_meses} meses em curso até ${data(c.fidelidade_fim)}.`, '', 'info'));
  }

  limpar(alvo,
    el('a', { href: '#/contratos', class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Contratos'),
    cabecalho({
      sobretitulo: `Contrato #${c.numero} · ${c.plano_nome}`,
      titulo: c.assinante_nome,
      descricao: [velocidade(c.download_mbps, c.upload_mbps), `vencimento dia ${c.dia_vencimento}`, c.cto_codigo ? `${c.cto_codigo}${c.porta_numero ? ` porta ${c.porta_numero}` : ''}` : null]
        .filter(Boolean).join(' · '),
      acoes,
    }),
    avisos,
    el('div', { class: 'stats' },
      stat({ rotulo: 'Mensalidade', valor: dinheiro(c.mensalidade_centavos), nota: `Valor contratado · vence dia ${c.dia_vencimento}`, ic: 'dinheiro' }),
      stat({ rotulo: 'Em aberto', valor: dinheiro(c.posicao.saldo_centavos), nota: c.posicao.vencidas ? `${c.posicao.vencidas} vencida(s) · ${c.posicao.atraso_dias} dia(s)` : 'Nada vencido',
        notaTipo: c.posicao.vencidas ? 'erro' : 'ok', ic: 'alerta' }),
      stat({ rotulo: 'Situação', valor: rotulo('situacaoContrato', c.situacao), nota: c.ativacao ? `Ativo desde ${data(c.ativacao)}` : 'Ainda não ativado', ic: 'atividade' }),
      stat({ rotulo: 'Carência antes do corte', valor: `${c.carencia_efetiva} dia(s)`, nota: c.carencia_dias === null ? 'Padrão da operação' : 'Própria deste contrato', ic: 'relogio' })),
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel('Serviços e descontos fixos', el('div', {},
          tabela([
            { titulo: 'Item', valor: (i) => el('div', {}, el('div', { class: 'forte' }, i.descricao), el('div', { class: 'fraco' }, rotulo('tipoItemContrato', i.tipo))) },
            { titulo: 'Valor', valor: (i) => el('span', { class: i.valor_centavos < 0 ? 'fraco' : '' }, dinheiro(i.valor_centavos)), classe: 'num' },
            { titulo: 'Vigência', valor: (i) => `${competencia(i.inicio)} → ${i.fim ? competencia(i.fim) : 'sem prazo'}` },
            { titulo: '', valor: (i) => (pode('contratos.editar') && !i.fim && c.situacao !== 'cancelado'
              ? el('button', { class: 'botao secundario pequeno', onclick: () => formulario('Encerrar o item', [
                { nome: 'fim', rotulo: 'Última competência cobrada', valor: hoje().slice(0, 7), ajuda: 'Formato AAAA-MM.' },
              ], { enviar: async (d) => { await api.post(`/contratos/${c.id}/itens/${i.id}/encerrar`, d); toast('Item encerrado.'); recarregar(); } }) }, 'Encerrar')
              : '') },
          ], c.itens, { vazioTexto: 'Só a mensalidade do plano.' }),
          pode('contratos.editar') && c.situacao !== 'cancelado'
            ? el('div', { class: 'form-acoes', style: 'justify-content:flex-start' }, botao('Incluir item', () => incluirItem(c, recarregar), { tipo: 'secundario pequeno', ic: 'mais' }))
            : null)),
        painel('Faturas', tabela([
          { titulo: 'Fatura', valor: (f) => el('div', {}, el('div', { class: 'forte' }, `#${f.numero}`),
            el('div', { class: 'fraco' }, f.competencia ? competencia(f.competencia) : 'Avulsa')) },
          { titulo: 'Vencimento', valor: (f) => el('div', {}, data(f.vencimento),
            f.encargos.dias_atraso ? el('div', { class: 'fraco' }, `${f.encargos.dias_atraso} dia(s) de atraso`) : null) },
          { titulo: 'Valor', valor: (f) => dinheiro(f.valor_centavos), classe: 'num' },
          { titulo: 'Devido hoje', valor: (f) => (f.encargos.total_devido_centavos ? dinheiro(f.encargos.total_devido_centavos) : el('span', { class: 'fraco' }, '—')), classe: 'num' },
          { titulo: 'Situação', valor: (f) => etqDe('situacaoFatura', f.situacao) },
        ], c.faturas, { vazioTexto: 'Nenhuma fatura emitida.', aoClicar: pode('faturamento.ver') ? (f) => ir(`#/faturamento/${f.id}`) : null }), { semCorpo: true }),
        painel('Histórico de bloqueios', tabela([
          { titulo: 'Bloqueio', valor: (b) => el('div', {}, el('div', { class: 'forte' }, rotulo('tipoBloqueio', b.tipo)),
            el('div', { class: 'fraco' }, b.motivo)) },
          { titulo: 'Origem', valor: (b) => el('div', {}, rotulo('origemAcao', b.origem), b.regra_nome ? el('div', { class: 'fraco' }, b.regra_nome) : null) },
          { titulo: 'Período', valor: (b) => el('div', {}, dataHora(b.inicio), el('div', { class: 'fraco' }, b.fim ? `até ${dataHora(b.fim)}` : 'em vigor')) },
          { titulo: 'Liberação', valor: (b) => (b.fim ? el('div', {}, b.liberado_por_nome ?? 'sistema', b.motivo_liberacao ? el('div', { class: 'fraco' }, b.motivo_liberacao) : null)
            : el('span', { class: 'fraco' }, '—')) },
        ], c.bloqueios, { vazioTexto: 'Nunca foi bloqueado.' }), { semCorpo: true })),
      el('div', {},
        painel('Dados', dl([
          ['Assinante', el('a', { href: `#/assinantes/${c.assinante_id}` }, `${c.assinante_codigo} · ${c.assinante_nome}`)],
          ['Plano', c.plano_nome],
          ['Mensalidade', dinheiro(c.mensalidade_centavos)],
          ['Taxa de instalação', c.instalacao_centavos ? dinheiro(c.instalacao_centavos) : 'Isenta'],
          ['Vencimento', `dia ${c.dia_vencimento}`],
          ['Ativação', data(c.ativacao)],
          ['Fidelidade até', c.fidelidade_fim ? data(c.fidelidade_fim) : 'Sem fidelidade'],
          ['Ponto na planta', c.cto_codigo ? `${c.cto_codigo}${c.porta_numero ? ` · porta ${c.porta_numero}` : ''}` : 'Não vinculado'],
          ['Endereço de instalação', [[c.logradouro, c.numero_endereco].filter(Boolean).join(', '), c.complemento, c.bairro, [c.cidade, c.uf].filter(Boolean).join('/')]
            .filter(Boolean).join(' · ') || 'O mesmo do assinante'],
          ['Confianças no ano', c.confiancas_no_ano],
          c.cancelado_em ? ['Cancelado em', `${data(c.cancelado_em)} · ${c.motivo_cancelamento}`] : null,
          ['Observações', c.observacoes],
        ])),
        painel('Linha do tempo', c.eventos.length
          ? el('ul', { class: 'linha-tempo' }, c.eventos.map((e) => el('li', {},
            el('strong', {}, rotulo('eventoContrato', e.evento)),
            e.motivo ? ` ${e.motivo}` : '',
            el('small', {}, `${dataHora(e.criado_em)} · ${e.usuario_nome ?? rotulo('origemAcao', e.origem)}`))))
          : el('p', { class: 'fraco' }, 'Sem histórico.')),
        c.chamados.length ? painel('Chamados na CTO deste contrato', el('ul', { class: 'linha-tempo' }, c.chamados.map((x) => el('li', {},
          el('a', { href: `#/chamados/${x.id}` }, `#${x.numero} ${x.titulo}`), el('small', {}, `${rotulo('statusChamado', x.status)} · ${dataHora(x.agendado_para)}`))))) : null)));
}

function editar(c, planos, depois) {
  return formulario(`Contrato #${c.numero}`, [
    { nome: 'plano_id', rotulo: 'Plano', tipo: 'select', vazio: false, inteiro: true, valor: c.plano_id,
      opcoes: planos.map((p) => [p.id, `${p.nome} · ${dinheiro(p.mensalidade_centavos)}`]) },
    { nome: 'mensalidade', rotulo: 'Mensalidade contratada (R$)', tipo: 'decimal', valor: (c.mensalidade_centavos / 100).toFixed(2).replace('.', ',') },
    { nome: 'motivo', rotulo: 'Motivo da mudança de valor', ajuda: 'Registrado na linha do tempo quando a mensalidade muda.' },
    { nome: 'dia_vencimento', rotulo: 'Dia do vencimento', tipo: 'number', min: 1, max: 28, valor: c.dia_vencimento },
    { nome: 'carencia_dias', rotulo: 'Carência própria (dias)', tipo: 'number', valor: c.carencia_dias, ajuda: 'Em branco usa a carência da operação.' },
    { nome: 'cto_id', rotulo: 'ID da CTO', tipo: 'number', valor: c.cto_id },
    { nome: 'porta_id', rotulo: 'ID da porta', tipo: 'number', valor: c.porta_id, ajuda: 'Trocar a porta libera a anterior e ocupa a nova na planta.' },
    { tipo: 'secao', rotulo: 'Endereço de instalação (em branco = o do assinante)' },
    { nome: 'cep', rotulo: 'CEP', valor: c.cep }, { nome: 'logradouro', rotulo: 'Logradouro', valor: c.logradouro },
    { nome: 'numero_endereco', rotulo: 'Número', valor: c.numero_endereco }, { nome: 'complemento', rotulo: 'Complemento', valor: c.complemento },
    { nome: 'bairro', rotulo: 'Bairro', valor: c.bairro }, { nome: 'cidade', rotulo: 'Cidade', valor: c.cidade }, { nome: 'uf', rotulo: 'UF', valor: c.uf },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', valor: c.observacoes, inteiro: true },
  ], {
    largo: true,
    enviar: async (d) => {
      await api.patch(`/contratos/${c.id}`, { ...d, versao: c.versao, cto_id: d.cto_id || null, porta_id: d.porta_id || null, carencia_dias: d.carencia_dias === '' ? null : d.carencia_dias });
      toast('Contrato salvo.');
      depois?.();
    },
  });
}

function incluirItem(c, depois) {
  return formulario('Incluir item no contrato', [
    { nome: 'descricao', rotulo: 'Descrição', obrigatorio: true, inteiro: true },
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', obrigatorio: true, opcoes: opcoes('tipoItemContrato') },
    { nome: 'valor', rotulo: 'Valor por mês (R$)', tipo: 'decimal', obrigatorio: true, ajuda: 'Informe sempre positivo: o desconto é guardado como abatimento.' },
    { nome: 'inicio', rotulo: 'Primeira competência', ajuda: 'AAAA-MM. Em branco usa a competência atual.' },
    { nome: 'fim', rotulo: 'Última competência', ajuda: 'AAAA-MM. Em branco vale sem prazo.' },
  ], {
    enviar: async (d) => {
      await api.post(`/contratos/${c.id}/itens`, { ...d, inicio: d.inicio || undefined, fim: d.fim || undefined });
      toast('Item incluído.');
      depois?.();
    },
  });
}

async function cancelar(c, depois) {
  const texto = c.posicao.saldo_centavos > 0
    ? `Este contrato tem ${dinheiro(c.posicao.saldo_centavos)} em aberto. As faturas continuam na cobrança depois do cancelamento.`
    : 'O cancelamento é definitivo: voltar a atender o assinante no mesmo endereço será um contrato novo.';
  if (!(await confirmar('Cancelar o contrato', `${texto} Deseja continuar?`, 'Continuar'))) return;
  return formulario(`Cancelar o contrato #${c.numero}`, [
    { nome: 'motivo', rotulo: 'Motivo do cancelamento', tipo: 'textarea', obrigatorio: true, inteiro: true },
    { nome: 'data', rotulo: 'Data do cancelamento', tipo: 'date', valor: hoje(), ajuda: 'O mês do cancelamento é cobrado pelos dias de serviço usados.' },
  ], {
    rotuloEnviar: 'Cancelar o contrato',
    antes: c.fidelidade_fim && c.fidelidade_fim > hoje()
      ? faixa(`Fidelidade em curso até ${data(c.fidelidade_fim)}: a multa contratual, se houver, é lançada como cobrança avulsa.`, 'aviso', 'alerta') : null,
    enviar: async (d) => {
      const r = await api.post(`/contratos/${c.id}/cancelar`, d);
      toast(r.aviso ?? 'Contrato cancelado.');
      depois?.();
    },
  });
}
