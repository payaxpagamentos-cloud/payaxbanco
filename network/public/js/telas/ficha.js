import { api } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, abas, etq, etqDe, rotulo, opcoes, dinheiro, numero, data, dataHora, desde, dl,
  documento, telefone, competencia, velocidade, carregando, formulario, pedirMotivo, botao, toast, faixa, stat, vazio, hoje } from '../ui.js';
import { baixa } from './faturamento.js';
import { painelWifi } from './wifi.js';

/*
 * Ficha do assinante: uma tela só.
 *
 * Tudo que se sabe do cliente vem numa resposta e fica na memória da tela. Trocar de aba NÃO vai ao servidor
 * de novo, e nenhuma ação (baixa, corte, religação, confiança, sincronizar, novo contrato) leva para outra
 * tela: tudo acontece aqui, em janela, e a ficha é relida uma vez quando algo muda.
 *
 * As abas que o perfil não pode ver nem aparecem: o servidor diz em `secoes_ocultas` o que deixou de fora.
 */

const ABAS = [
  ['resumo', 'Resumo', null],
  ['contratos', 'Contratos', 'contratos'],
  ['financeiro', 'Financeiro', 'financeiro'],
  ['cobranca', 'Cobrança', 'cobranca'],
  ['atendimentos', 'Atendimentos', 'atendimentos'],
  ['historico', 'Histórico', null],
  ['cadastro', 'Cadastro', null],
];

export default async function ficha({ alvo, id, query, ir, editarAssinante }) {
  limpar(alvo, carregando('Abrindo a ficha…'));
  let f;
  try { f = await api.get(`/assinantes/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }

  const recarregar = () => ficha({ alvo, id, query, ir, editarAssinante });
  const visiveis = ABAS.filter(([, , secao]) => !secao || !f.secoes_ocultas.includes(secao));
  let aba = visiveis.some(([k]) => k === (query.aba ?? '')) ? query.aba : 'resumo';
  const corpo = el('div');
  const ctx = { f, ir, recarregar };

  const barraAlvo = el('div');
  /*
   * Trocar de aba NÃO vai ao servidor: a ficha inteira já está em `f`. Só o corpo é redesenhado, e o endereço
   * acompanha para a aba poder ser compartilhada e para o voltar do navegador funcionar.
   */
  const trocarAba = (k) => {
    aba = k;
    history.replaceState(null, '', `#/assinantes/${id}?aba=${k}`);
    limpar(barraAlvo, abas(visiveis.map(([x, r]) => [x, r]), aba, trocarAba));
    limpar(corpo, conteudo(aba, ctx));
  };
  limpar(barraAlvo, abas(visiveis.map(([k, r]) => [k, r]), aba, trocarAba));

  const acoes = [
    pode('assinantes.editar') ? botao('Editar cadastro', () => editarAssinante(f, recarregar), { tipo: 'secundario' }) : null,
    pode('contratos.editar') ? botao('Novo contrato', async () => {
      const planos = await api.get('/planos?ativos=1').catch(() => []);
      novoContrato(f, planos, recarregar);
    }, { ic: 'mais' }) : null,
    pode('faturamento.faturar') ? botao('Cobrança avulsa', () => cobrancaAvulsa(f, recarregar), { tipo: 'secundario', ic: 'recibo' }) : null,
  ];

  limpar(alvo,
    el('a', { href: '#/assinantes', class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Assinantes'),
    cabecalho({
      sobretitulo: `${rotulo('tipoPessoa', f.tipo)} · assinante ${f.codigo}${f.cidade ? ` · ${[f.bairro, f.cidade].filter(Boolean).join(', ')}` : ''}`,
      titulo: f.nome,
      descricao: [documento(f.documento), f.nome_fantasia, telefone(f.telefone), f.email].filter(Boolean).join(' · '),
      acoes,
    }),
    alertas(f),
    indicadores(f),
    barraAlvo,
    limpar(corpo, conteudo(aba, ctx)));
}

/** O que precisa ser dito antes de qualquer clique. */
function alertas(f) {
  const avisos = [];
  const bloqueados = (f.contratos ?? []).filter((c) => c.situacao === 'bloqueado');
  const confianca = (f.contratos ?? []).find((c) => c.confianca);
  if (bloqueados.length) {
    avisos.push(faixa(`Serviço bloqueado em ${bloqueados.length} contrato(s): ${bloqueados.map((c) => `#${c.numero} ${c.bloqueio?.motivo ?? ''}`).join(' · ')}`, 'erro', 'cadeado'));
  }
  if (confianca) {
    avisos.push(faixa(`Desbloqueio de confiança no contrato #${confianca.numero} até ${data(confianca.confianca.ate)}. Sem pagamento até lá, a rotina bloqueia de novo.`, 'aviso', 'relogio'));
  }
  if (f.financeiro?.posicao.vencidas) {
    avisos.push(faixa(`${f.financeiro.posicao.vencidas} fatura(s) vencida(s), ${dinheiro(f.financeiro.posicao.devido_centavos)} devidos hoje · maior atraso de ${f.financeiro.posicao.atraso_dias} dia(s).`, 'erro', 'alerta'));
  }
  const divergentes = (f.contratos ?? []).filter((c) => c.servico?.divergencias.some((d) => d.gravidade === 'critica'));
  if (divergentes.length) {
    avisos.push(faixa(`Contrato e equipamento não batem em ${divergentes.length} contrato(s): ${divergentes[0].servico.divergencias[0].texto}`, 'erro', 'servidor'));
  }
  if (f.cobranca?.pendentes_envio.length) {
    avisos.push(faixa(`${f.cobranca.pendentes_envio.length} aviso(s) de cobrança prontos e aguardando envio.`, 'aviso', 'sino'));
  }
  return avisos;
}

function indicadores(f) {
  const r = f.resumo;
  const estados = { 'Serviço ativo': 'ok', 'Serviço bloqueado': 'erro', 'Suspenso a pedido': 'aviso', 'Em implantação': 'info' };
  return el('div', { class: 'stats' },
    r.servico !== null ? stat({ rotulo: 'Serviço', valor: r.servico, nota: r.cliente_desde ? `cliente desde ${data(r.cliente_desde)}` : 'sem contrato',
      notaTipo: estados[r.servico] === 'erro' ? 'erro' : '', ic: 'atividade' }) : null,
    r.saldo_centavos !== undefined ? stat({ rotulo: 'Em aberto', valor: dinheiro(r.saldo_centavos),
      nota: r.vencidas ? `${r.vencidas} vencida(s) · ${r.atraso_dias} dia(s)` : 'nada vencido', notaTipo: r.vencidas ? 'erro' : 'ok', ic: 'dinheiro' }) : null,
    r.devido_centavos !== undefined ? stat({ rotulo: 'Devido hoje', valor: dinheiro(r.devido_centavos), nota: 'com multa e juros', ic: 'alerta' }) : null,
    r.mensalidade_centavos !== null ? stat({ rotulo: 'Mensalidade', valor: dinheiro(r.mensalidade_centavos),
      nota: `${numero(r.contratos_vivos)} contrato(s) em vigor`, ic: 'recibo' }) : null);
}

function conteudo(aba, ctx) {
  if (aba === 'contratos') return contratos(ctx);
  if (aba === 'financeiro') return financeiro(ctx);
  if (aba === 'cobranca') return cobranca(ctx);
  if (aba === 'atendimentos') return atendimentos(ctx);
  if (aba === 'historico') return historico(ctx);
  if (aba === 'cadastro') return cadastro(ctx);
  return resumo(ctx);
}

// ---------------- Resumo ----------------
function resumo({ f, ir, recarregar }) {
  const vivos = (f.contratos ?? []).filter((c) => c.situacao !== 'cancelado');
  const abertas = (f.financeiro?.faturas ?? []).filter((x) => ['aberta', 'parcial'].includes(x.situacao))
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  return el('div', { class: 'grade principal-lateral' },
    el('div', {},
      painel('Contratos em vigor', vivos.length ? el('div', { class: 'grade' }, vivos.map((c) => cartaoContrato(c, { f, recarregar }, true)))
        : vazio('Nenhum contrato em vigor.', 'Este assinante não tem serviço contratado agora.')),
      f.financeiro ? painel('Faturas em aberto', tabela([
        { titulo: 'Fatura', valor: (x) => el('div', {}, el('div', { class: 'forte' }, `#${x.numero}`),
          el('div', { class: 'fraco' }, x.competencia ? competencia(x.competencia) : 'avulsa')) },
        { titulo: 'Vencimento', valor: (x) => el('div', {}, data(x.vencimento),
          x.encargos.dias_atraso ? el('div', { class: 'fraco' }, `${x.encargos.dias_atraso} dia(s) de atraso`) : null) },
        { titulo: 'Valor', valor: (x) => dinheiro(x.valor_centavos), classe: 'num' },
        { titulo: 'Devido hoje', valor: (x) => dinheiro(x.encargos.total_devido_centavos), classe: 'num' },
        { titulo: 'Situação', valor: (x) => etqDe('situacaoFatura', x.situacao) },
        { titulo: '', valor: (x) => (pode('faturamento.baixar') ? botao('Baixa', () => baixa(x, recarregar), { tipo: 'secundario pequeno' }) : '') },
      ], abertas, { vazioTexto: 'Nada em aberto.' }), { semCorpo: true }) : null),
    el('div', {},
      painel('Últimos acontecimentos', (f.linha_tempo ?? []).length
        ? el('ul', { class: 'linha-tempo' }, f.linha_tempo.slice(0, 8).map(itemLinha))
        : el('p', { class: 'fraco' }, 'Sem histórico.')),
      f.cobranca?.pendentes_envio.length ? painel('Avisos a enviar', el('div', {},
        f.cobranca.pendentes_envio.map((a) => el('div', { style: 'margin-bottom:10px' },
          el('div', { class: 'forte' }, `${a.regra_nome} · fatura ${a.fatura_numero}`),
          el('div', { class: 'fraco' }, `${rotulo('canalRegua', a.canal)} · vence ${data(a.vencimento)}`),
          a.regra_texto ? el('p', { class: 'fraco', style: 'margin-top:4px' }, a.regra_texto) : null,
          pode('cobranca.executar') ? botao('Marcar enviado', async () => {
            await api.post(`/cobranca/eventos/${a.id}/enviado`);
            toast('Aviso marcado como enviado.');
            recarregar();
          }, { tipo: 'secundario pequeno' }) : null)))) : null));
}

// ---------------- Contratos ----------------
function contratos({ f, recarregar }) {
  if (!f.contratos.length) return vazio('Nenhum contrato.', 'Use "Novo contrato" no topo para criar o primeiro.');
  return el('div', { class: 'grade' }, f.contratos.map((c) => cartaoContrato(c, { f, recarregar }, false)));
}

/** Cartão do contrato: no resumo vem compacto; na aba Contratos vem com tudo aberto. */
function cartaoContrato(c, { f, recarregar }, compacto) {
  const chamar = async (caminho, corpo, mensagem) => {
    const r = await api.post(caminho, corpo);
    toast(r.aviso ?? mensagem);
    recarregar();
  };
  const acoes = [];
  if (pode('contratos.ciclo') && c.situacao === 'em_implantacao') {
    acoes.push(botao('Ativar', () => formulario(`Ativar o contrato #${c.numero}`, [
      { nome: 'ativacao', rotulo: 'Data da ativação', tipo: 'date', valor: hoje(), obrigatorio: true, ajuda: 'A primeira fatura é proporcional a partir deste dia.' },
      { nome: 'porta_id', rotulo: 'ID da porta na CTO', tipo: 'number', valor: c.porta_id },
    ], { enviar: (d) => chamar(`/contratos/${c.id}/ativar`, { ...d, porta_id: d.porta_id || undefined }, 'Serviço ativado.') }), { tipo: 'pequeno', ic: 'ok' }));
  }
  if (pode('bloqueios.liberar') && c.situacao === 'bloqueado') {
    acoes.push(botao('Desbloquear', () => pedirMotivo('Liberar o serviço', 'Motivo da liberação',
      (motivo) => chamar(`/cobranca/contratos/${c.id}/desbloquear`, { motivo }, 'Serviço liberado.')), { tipo: 'pequeno', ic: 'ok' }));
    if (c.bloqueio?.tipo === 'inadimplencia' && !c.confianca) {
      acoes.push(botao('Confiança', () => formulario('Desbloqueio de confiança', [
        { nome: 'dias', rotulo: 'Dias de prazo', tipo: 'number', ajuda: 'Em branco usa o prazo padrão da operação.' },
        { nome: 'motivo', rotulo: 'Motivo', inteiro: true },
      ], { enviar: (d) => chamar(`/cobranca/contratos/${c.id}/confianca`, { ...d, dias: d.dias || undefined }, 'Serviço liberado por confiança.') }),
      { tipo: 'secundario pequeno', ic: 'relogio' }));
    }
  }
  if (pode('bloqueios.aplicar') && ['ativo', 'suspenso'].includes(c.situacao)) {
    acoes.push(botao('Bloquear', () => formulario(`Bloquear o contrato #${c.numero}`, [
      { nome: 'tipo', rotulo: 'Motivo do bloqueio', tipo: 'select', obrigatorio: true, opcoes: opcoes('tipoBloqueio') },
      { nome: 'motivo', rotulo: 'Detalhe', obrigatorio: true, inteiro: true },
    ], { enviar: (d) => chamar(`/cobranca/contratos/${c.id}/bloquear`, d, 'Serviço bloqueado.') }), { tipo: 'perigo pequeno', ic: 'cadeado' }));
  }
  if (pode('contratos.ciclo') && c.situacao === 'ativo') {
    acoes.push(botao('Suspender', () => pedirMotivo('Suspender a pedido do assinante', 'Motivo da suspensão',
      (motivo) => chamar(`/contratos/${c.id}/suspender`, { motivo }, 'Contrato suspenso.'),
      { ajuda: 'Suspenso a pedido não entra no faturamento mensal.' }), { tipo: 'secundario pequeno' }));
  }
  if (pode('contratos.ciclo') && c.situacao === 'suspenso') {
    acoes.push(botao('Reativar', () => chamar(`/contratos/${c.id}/reativar`, {}, 'Contrato reativado.'), { tipo: 'secundario pequeno', ic: 'atualizar' }));
  }

  const dadosPrincipais = dl([
    ['Plano', `${c.plano_nome}${c.download_mbps ? ` · ${velocidade(c.download_mbps, c.upload_mbps)}` : ''}`],
    ['Mensalidade', `${dinheiro(c.mensalidade_centavos)} · vence dia ${c.dia_vencimento}`],
    ['Ativação', c.ativacao ? data(c.ativacao) : 'ainda não ativado'],
    c.fidelidade_em_curso ? ['Fidelidade', `até ${data(c.fidelidade_fim)}`] : null,
    ['Ponto na planta', c.cto_codigo ? `${c.cto_codigo}${c.porta_numero ? ` · porta ${c.porta_numero}` : ''}${c.cto_bairro ? ` · ${c.cto_bairro}` : ''}` : 'não vinculado'],
    ['Endereço', [[c.logradouro, c.numero_endereco].filter(Boolean).join(', '), c.complemento, c.bairro, [c.cidade, c.uf].filter(Boolean).join('/')]
      .filter(Boolean).join(' · ') || 'o mesmo do assinante'],
    ['Em aberto', c.posicao.saldo_centavos ? `${dinheiro(c.posicao.saldo_centavos)} · ${c.posicao.vencidas} vencida(s)` : 'nada'],
    c.cancelado_em ? ['Cancelado em', `${data(c.cancelado_em)} · ${c.motivo_cancelamento}`] : null,
  ]);

  const corpo = el('div', {},
    c.bloqueio ? faixa(`${rotulo('tipoBloqueio', c.bloqueio.tipo)} desde ${dataHora(c.bloqueio.inicio)} · ${rotulo('origemAcao', c.bloqueio.origem)}: ${c.bloqueio.motivo}`, 'erro', 'cadeado') : null,
    dadosPrincipais,
    acoes.length ? el('div', { class: 'form-acoes', style: 'justify-content:flex-start;flex-wrap:wrap' }, acoes) : null,
    compacto ? null : el('div', {},
      c.itens.length ? el('details', { class: 'bloco-expansivel' }, el('summary', {}, `Serviços e descontos fixos (${c.itens.length})`),
        tabela([
          { titulo: 'Item', valor: (i) => el('div', {}, el('div', { class: 'forte' }, i.descricao), el('div', { class: 'fraco' }, rotulo('tipoItemContrato', i.tipo))) },
          { titulo: 'Valor', valor: (i) => dinheiro(i.valor_centavos), classe: 'num' },
          { titulo: 'Vigência', valor: (i) => `${competencia(i.inicio)} → ${i.fim ? competencia(i.fim) : 'sem prazo'}` },
        ], c.itens)) : null,
      el('details', { class: 'bloco-expansivel' }, el('summary', {}, 'Serviço no equipamento'),
        c.servico ? blocoServico(c, recarregar)
          : el('p', { class: 'fraco', style: 'padding:8px 0' }, 'Contrato não provisionado: o bloqueio por inadimplência seria só comercial, sem cortar o acesso.')),
      el('details', { class: 'bloco-expansivel' }, el('summary', {}, `Wi-Fi do assinante${c.servico?.cpe ? '' : ' (aparelho não conectado ao ACS)'}`),
        painelWifi(c.servico?.cpe ?? null, recarregar, { titulo: null })),
      c.eventos.length ? el('details', { class: 'bloco-expansivel' }, el('summary', {}, `Histórico do contrato (${c.eventos.length})`),
        el('ul', { class: 'linha-tempo' }, c.eventos.slice(0, 20).map((e) => el('li', {},
          el('strong', {}, rotulo('eventoContrato', e.evento)), e.motivo ? ` ${e.motivo}` : '',
          el('small', {}, `${dataHora(e.criado_em)} · ${e.usuario_nome ?? rotulo('origemAcao', e.origem)}`))))) : null));

  return painel(`Contrato #${c.numero}`, corpo, {
    acoes: [etqDe('situacaoContrato', c.situacao), c.servico?.divergencias.some((d) => d.gravidade !== 'aviso') ? etq('Equipamento divergente', 'erro') : null],
  });
}

/** Resumo do serviço no equipamento, com as ações que não saem da ficha. */
function blocoServico(c, recarregar) {
  const s = c.servico;
  const acao = async (caminho, mensagem) => {
    const r = await api.post(`/provisionamento/servicos/${s.id}${caminho}`);
    const m = r.tarefa?.resultado?.mudancas ?? [];
    toast(r.tarefa.situacao === 'concluida' ? `${mensagem}${m.length ? `: ${m.join(', ')}` : ' (nada a mudar)'}` : `Na fila: ${r.tarefa.erro ?? 'o equipamento não respondeu agora'}`,
      r.tarefa.situacao !== 'concluida');
    recarregar();
  };
  const graves = s.divergencias.filter((d) => d.gravidade !== 'aviso');
  return el('div', {},
    graves.length ? faixa(graves.map((d) => `${d.texto}${d.esperado ? ` (contratado: ${d.esperado}; equipamento: ${d.real})` : ''}`).join(' '), graves[0].gravidade === 'critica' ? 'erro' : 'aviso', 'alerta') : null,
    dl([
      ['Concentrador', s.concentrador_nome ?? 'não definido'],
      ['Acesso', `${s.tipo_acesso.toUpperCase()}${s.login ? ` · ${s.login}` : ''}`],
      ['Contratado', s.desejado.perfil ?? (s.desejado.download_kbps ? `${numero(s.desejado.download_kbps / 1000)}/${numero(s.desejado.upload_kbps / 1000)} Mbps` : '—')],
      ['No equipamento', s.estado_real
        ? (s.estado_real.presente
          ? `${rotulo('situacaoServico', s.estado_real.situacao)}${s.estado_real.conectado ? ` · conectado em ${s.estado_real.ip_atual ?? '—'}` : ' · sem sessão'}`
          : 'não existe no equipamento')
        : 'nunca lido'],
      ['Última leitura', s.lido_em ? `${dataHora(s.lido_em)} (${desde(s.lido_em)})` : 'nunca'],
      s.onu_serial ? ['ONU', `${s.onu_serial}${s.pon ? ` · PON ${s.pon}` : ''}`] : null,
    ]),
    el('div', { class: 'form-acoes', style: 'justify-content:flex-start;flex-wrap:wrap' },
      pode('contratos.ver') ? botao('Ler do equipamento', () => acao('/ler', 'Leitura feita'), { tipo: 'secundario pequeno', ic: 'atualizar' }) : null,
      pode('contratos.editar') ? botao('Sincronizar', () => acao('/sincronizar', 'Sincronizado'), { tipo: 'secundario pequeno', ic: 'ok' }) : null));
}

// ---------------- Financeiro ----------------
function financeiro({ f, recarregar }) {
  const d = f.financeiro;
  const linhas = d.faturas;
  return el('div', {},
    el('div', { class: 'stats' },
      stat({ rotulo: 'Em aberto', valor: dinheiro(d.posicao.saldo_centavos), nota: `${numero(d.posicao.abertas)} fatura(s)`, ic: 'dinheiro' }),
      stat({ rotulo: 'Devido hoje', valor: dinheiro(d.posicao.devido_centavos), nota: 'com multa e juros', ic: 'alerta' }),
      stat({ rotulo: 'Vencidas', valor: numero(d.posicao.vencidas), nota: d.posicao.atraso_dias ? `maior atraso ${d.posicao.atraso_dias} dia(s)` : 'nenhuma',
        notaTipo: d.posicao.vencidas ? 'erro' : 'ok', ic: 'relogio' }),
      stat({ rotulo: 'Pago em 12 meses', valor: dinheiro(d.posicao.pago_12_meses_centavos), nota: 'baixas em vigor', ic: 'ok' })),
    painel('Faturas', el('div', {},
      d.tem_limite ? faixa('Mostrando as faturas mais recentes. Para o histórico inteiro, use a tela de Faturamento.', '', 'info') : null,
      linhas.length ? el('div', {}, linhas.map((x) => faturaExpansivel(x, recarregar))) : vazio('Nenhuma fatura emitida.'))));
}

/** Fatura que abre no lugar, com itens e baixas — sem ir para outra tela. */
function faturaExpansivel(x, recarregar) {
  const saldo = x.valor_centavos - x.pago_centavos;
  return el('details', { class: 'bloco-expansivel fatura' },
    el('summary', {},
      el('span', { class: 'forte' }, `#${x.numero}`),
      el('span', { class: 'fraco' }, x.competencia ? competencia(x.competencia) : 'avulsa'),
      el('span', {}, `vence ${data(x.vencimento)}`),
      el('span', { class: 'num' }, dinheiro(x.valor_centavos)),
      x.encargos.dias_atraso ? el('span', { class: 'fraco' }, `${x.encargos.dias_atraso} dia(s) de atraso`) : null,
      etqDe('situacaoFatura', x.situacao)),
    el('div', { class: 'detalhe-fatura' },
      tabela([
        { titulo: 'Item', valor: (i) => el('div', {}, el('div', { class: 'forte' }, i.descricao), el('div', { class: 'fraco' }, rotulo('origemItem', i.origem))) },
        { titulo: 'Valor', valor: (i) => dinheiro(i.valor_centavos), classe: 'num' },
      ], x.itens, { vazioTexto: 'Sem itens.' }),
      x.encargos.dias_atraso && saldo > 0
        ? faixa(`Multa ${dinheiro(x.encargos.multa_centavos)} + juros ${dinheiro(x.encargos.juros_centavos)} calculados para hoje. O valor da fatura não muda.`, 'aviso', 'info')
        : null,
      x.pagamentos.length ? tabela([
        { titulo: 'Baixa', valor: (p) => el('div', {}, el('div', { class: p.estornado_em ? 'fraco' : 'forte' }, `${dinheiro(p.valor_centavos)} · ${rotulo('formaPagamento', p.forma)}`),
          el('div', { class: 'fraco' }, [data(p.data), p.criado_por_nome].filter(Boolean).join(' · '))) },
        { titulo: 'Situação', valor: (p) => (p.estornado_em ? el('div', {}, etq('Estornada', 'neutra'), el('div', { class: 'fraco' }, p.motivo_estorno)) : etq('Em vigor', 'ok')) },
        { titulo: '', valor: (p) => (pode('faturamento.estornar') && !p.estornado_em
          ? botao('Estornar', () => pedirMotivo('Estornar a baixa', 'Motivo do estorno', async (motivo) => {
            const r = await api.post(`/faturamento/pagamentos/${p.id}/estornar`, { motivo });
            toast(r.aviso ?? 'Baixa estornada.');
            recarregar();
          }), { tipo: 'secundario pequeno' }) : '') },
      ], x.pagamentos) : el('p', { class: 'fraco' }, 'Nenhuma baixa registrada.'),
      el('div', { class: 'form-acoes', style: 'justify-content:flex-start' },
        pode('faturamento.baixar') && !['paga', 'cancelada'].includes(x.situacao) ? botao('Registrar baixa', () => baixa(x, recarregar), { tipo: 'pequeno', ic: 'ok' }) : null,
        pode('faturamento.estornar') && x.situacao !== 'cancelada' ? botao('Cancelar fatura', () => pedirMotivo('Cancelar a fatura', 'Motivo do cancelamento', async (motivo) => {
          const r = await api.post(`/faturamento/faturas/${x.id}/cancelar`, { motivo });
          toast(r.aviso ?? 'Fatura cancelada.');
          recarregar();
        }, { ajuda: 'A fatura não é apagada: fica cancelada, com o motivo e quem cancelou.' }), { tipo: 'perigo pequeno' }) : null)));
}

// ---------------- Cobrança ----------------
function cobranca({ f, recarregar }) {
  const d = f.cobranca;
  return el('div', {},
    painel('Avisos e ações da régua', tabela([
      { titulo: 'Quando', valor: (a) => el('div', {}, dataHora(a.executado_em), el('div', { class: 'fraco' }, desde(a.executado_em))) },
      { titulo: 'Regra', valor: (a) => el('div', {}, el('div', { class: 'forte' }, a.regra_nome), el('div', { class: 'fraco' }, `${rotulo('acaoRegua', a.acao)} · ${rotulo('canalRegua', a.canal)}`)) },
      { titulo: 'Fatura', valor: (a) => el('div', {}, `#${a.fatura_numero}`, el('div', { class: 'fraco' }, `vence ${data(a.vencimento)}${a.dias_atraso > 0 ? ` · ${a.dias_atraso} dia(s)` : ''}`)) },
      { titulo: 'Resultado', valor: (a) => el('div', {}, etqDe('resultadoRegua', a.resultado), a.detalhe ? el('div', { class: 'fraco' }, a.detalhe) : null,
        a.enviado_em ? el('div', { class: 'fraco' }, `enviado ${dataHora(a.enviado_em)} por ${a.enviado_por_nome ?? '—'}`) : null) },
      { titulo: '', valor: (a) => (pode('cobranca.executar') && a.resultado === 'pendente_envio' && !a.enviado_em
        ? botao('Marcar enviado', async () => { await api.post(`/cobranca/eventos/${a.id}/enviado`); toast('Aviso marcado como enviado.'); recarregar(); }, { tipo: 'secundario pequeno' }) : '') },
    ], d.avisos, { vazioTexto: 'A régua ainda não alcançou nenhuma fatura deste assinante.' }), { semCorpo: true }),
    painel('Bloqueios', tabela([
      { titulo: 'Contrato', valor: (b) => `#${b.contrato_numero}` },
      { titulo: 'Motivo', valor: (b) => el('div', {}, rotulo('tipoBloqueio', b.tipo), el('div', { class: 'fraco' }, b.motivo)) },
      { titulo: 'Origem', valor: (b) => el('div', {}, rotulo('origemAcao', b.origem),
        el('div', { class: 'fraco' }, [b.regra_nome, b.fatura_numero ? `fatura #${b.fatura_numero}` : null, b.criado_por_nome].filter(Boolean).join(' · '))) },
      { titulo: 'Período', valor: (b) => el('div', {}, dataHora(b.inicio), el('div', { class: 'fraco' }, b.fim ? `até ${dataHora(b.fim)}` : 'em vigor')) },
      { titulo: 'Liberação', valor: (b) => (b.fim ? el('div', {}, b.liberado_por_nome ?? 'sistema', b.motivo_liberacao ? el('div', { class: 'fraco' }, b.motivo_liberacao) : null) : el('span', { class: 'fraco' }, '—')) },
    ], d.bloqueios, { vazioTexto: 'Nunca foi bloqueado.' }), { semCorpo: true }),
    painel(`Desbloqueios de confiança (${d.confiancas_no_ano} neste ano)`, tabela([
      { titulo: 'Contrato', valor: (c) => `#${c.contrato_numero}` },
      { titulo: 'Prazo', valor: (c) => el('div', {}, `${data(c.inicio)} → ${data(c.ate)}`, c.motivo ? el('div', { class: 'fraco' }, c.motivo) : null) },
      { titulo: 'Concedida por', valor: (c) => c.concedida_por_nome ?? '—' },
      { titulo: 'Estado', valor: (c) => etqDe('estadoConfianca', c.estado) },
    ], d.confiancas, { vazioTexto: 'Nenhum desbloqueio de confiança concedido.' }), { semCorpo: true }));
}

// ---------------- Atendimentos ----------------
function atendimentos({ f, ir }) {
  return painel('Chamados técnicos', tabela([
    { titulo: 'Chamado', valor: (c) => el('div', {}, el('div', { class: 'forte' }, `#${c.numero} ${c.titulo}`),
      el('div', { class: 'fraco' }, [rotulo('tipoChamado', c.tipo), rotulo('prioridade', c.prioridade), c.bairro].filter(Boolean).join(' · '))) },
    { titulo: 'Vínculo', valor: (c) => (c.vinculo === 'assinante' ? etq('Deste assinante', 'ok') : etq('Mesmo ponto na rede', 'neutra')) },
    { titulo: 'Agenda', valor: (c) => dataHora(c.agendado_para) },
    { titulo: 'Aberto em', valor: (c) => el('div', {}, dataHora(c.criado_em), el('div', { class: 'fraco' }, desde(c.criado_em))) },
    { titulo: 'Situação', valor: (c) => etqDe('statusChamado', c.status) },
  ], f.chamados, {
    vazioTexto: 'Nenhum chamado para este assinante.',
    aoClicar: pode('chamados.ver') ? (c) => ir(`#/chamados/${c.id}`) : null,
  }), { semCorpo: true, rodape: el('span', {}, 'Chamados do "mesmo ponto na rede" são da CTO deste contrato e podem ser de outro assinante.') });
}

// ---------------- Histórico ----------------
const ICONE_LINHA = { fatura: 'recibo', pagamento: 'dinheiro', pagamento_estornado: 'atualizar', chamado: 'chamado', confianca: 'relogio' };
function itemLinha(e) {
  return el('li', { class: e.gravidade === 'alta' ? 'grave' : '' },
    el('strong', {}, e.titulo),
    e.detalhe ? ` ${e.detalhe}` : '',
    el('small', {}, [dataHora(e.em), e.contrato ? `contrato #${e.contrato}` : null, e.usuario ?? (e.origem ? rotulo('origemAcao', e.origem) : null)].filter(Boolean).join(' · ')));
}

function historico({ f }) {
  return painel('Tudo que aconteceu com este assinante', f.linha_tempo.length
    ? el('ul', { class: 'linha-tempo' }, f.linha_tempo.map(itemLinha))
    : vazio('Sem histórico.'), { rodape: el('span', {}, `${f.linha_tempo.length} acontecimento(s), do mais recente ao mais antigo. Inclui contrato, faturamento, cobrança e chamados.`) });
}

// ---------------- Cadastro ----------------
function cadastro({ f }) {
  return el('div', { class: 'grade duas' },
    painel('Identificação', dl([
      ['Tipo', rotulo('tipoPessoa', f.tipo)],
      ['Nome', f.nome],
      ['Nome fantasia', f.nome_fantasia],
      ['Documento', documento(f.documento)],
      [f.tipo === 'pj' ? 'Inscrição estadual' : 'RG', f.identidade],
      [f.tipo === 'pj' ? 'Abertura' : 'Nascimento', f.nascimento ? data(f.nascimento) : null],
      ['Situação', etqDe('situacaoAssinante', f.situacao)],
      ['Código', f.codigo],
      ['Cadastrado em', dataHora(f.criado_em)],
    ])),
    painel('Contato e endereço', dl([
      ['Telefone', telefone(f.telefone)],
      ['Outro telefone', f.telefone2 ? telefone(f.telefone2) : null],
      ['E-mail', f.email],
      ['Endereço', [[f.logradouro, f.numero].filter(Boolean).join(', '), f.complemento].filter(Boolean).join(' · ')],
      ['Bairro', f.bairro],
      ['Cidade', [f.cidade, f.uf].filter(Boolean).join('/')],
      ['CEP', f.cep],
      ['Coordenadas', f.latitude ? `${f.latitude}, ${f.longitude}` : null],
      ['Consentimento LGPD', f.consentimento_em ? dataHora(f.consentimento_em) : 'não registrado'],
      ['Observações', f.observacoes],
    ])));
}

// ---------------- Ações do topo ----------------
function novoContrato(f, planos, depois) {
  return formulario(`Novo contrato · ${f.nome}`, [
    { nome: 'plano_id', rotulo: 'Plano', tipo: 'select', obrigatorio: true, inteiro: true,
      opcoes: planos.map((p) => [p.id, `${p.nome} · ${dinheiro(p.mensalidade_centavos)}${p.download_mbps ? ` · ${velocidade(p.download_mbps, p.upload_mbps)}` : ''}`]) },
    { nome: 'mensalidade', rotulo: 'Mensalidade contratada (R$)', tipo: 'decimal', ajuda: 'Em branco usa o valor do plano.' },
    { nome: 'instalacao', rotulo: 'Taxa de instalação (R$)', tipo: 'decimal', ajuda: 'Em branco usa a taxa do plano.' },
    { nome: 'dia_vencimento', rotulo: 'Dia do vencimento', tipo: 'number', min: 1, max: 28, ajuda: 'De 1 a 28.' },
    { tipo: 'secao', rotulo: 'Endereço de instalação (em branco = o do assinante)' },
    { nome: 'cep', rotulo: 'CEP' }, { nome: 'logradouro', rotulo: 'Logradouro' }, { nome: 'numero_endereco', rotulo: 'Número' },
    { nome: 'bairro', rotulo: 'Bairro' }, { nome: 'cidade', rotulo: 'Cidade' }, { nome: 'uf', rotulo: 'UF' },
  ], {
    largo: true,
    antes: faixa('O contrato nasce em implantação: só fatura e só pode bloquear depois de ativado.', '', 'info'),
    enviar: async (d) => {
      const r = await api.post('/contratos', { ...d, assinante_id: f.id, dia_vencimento: d.dia_vencimento || undefined });
      toast(`Contrato #${r.numero} criado em implantação.`);
      depois?.();
    },
  });
}

function cobrancaAvulsa(f, depois) {
  return formulario(`Cobrança avulsa · ${f.nome}`, [
    { nome: 'vencimento', rotulo: 'Vencimento', tipo: 'date', obrigatorio: true, valor: hoje() },
    { nome: 'descricao', rotulo: 'Descrição', obrigatorio: true, inteiro: true, ajuda: 'Ex.: visita técnica, material, multa de fidelidade.' },
    { nome: 'valor', rotulo: 'Valor (R$)', tipo: 'decimal', obrigatorio: true },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true },
  ], {
    antes: faixa('A avulsa não pertence a competência nenhuma: o ciclo mensal não a toca, mas ela entra na régua como qualquer fatura.', '', 'info'),
    enviar: async (d) => {
      const r = await api.post('/faturamento/faturas', { assinante_id: f.id, vencimento: d.vencimento, observacoes: d.observacoes,
        itens: [{ descricao: d.descricao, valor: d.valor }] });
      toast(`Fatura #${r.numero} emitida.`);
      depois?.();
    },
  });
}
