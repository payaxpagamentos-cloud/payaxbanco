import { api, qs, baixar } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, paginacao, abas, etq, etqDe, rotulo, opcoes, dinheiro, data, dataHora, telefone,
  numero, porcento, carregar, formulario, confirmar, botao, toast, faixa, stat, vazio, hoje } from '../ui.js';

const ABAS = [['inadimplencia', 'Inadimplência'], ['regua', 'Régua de cobrança'], ['avisos', 'Avisos a enviar'], ['bloqueios', 'Bloqueios'], ['confiancas', 'Confianças']];

export default async function cobranca({ alvo, query, ir }) {
  const aba = query.aba ?? 'inadimplencia';
  const corpo = el('div');
  const recarregar = () => cobranca({ alvo, query, ir });

  limpar(alvo, cabecalho({
    sobretitulo: 'Assinantes e financeiro',
    titulo: 'Cobrança e bloqueios',
    descricao: 'Quem corta o serviço é sempre uma regra identificada, e a carência é respeitada antes de qualquer bloqueio. Cancelar contrato nunca é automático.',
    acoes: [pode('cobranca.executar') ? botao('Executar a régua agora', () => executar(recarregar), { ic: 'atualizar' }) : null],
  }), abas(ABAS, aba, (id) => ir(`#/cobranca?aba=${id}`)), corpo);

  if (aba === 'regua') return carregar(corpo, () => api.get('/cobranca/regras'), (d) => desenharRegras(d, recarregar));
  if (aba === 'avisos') return avisos(corpo);
  if (aba === 'bloqueios') return bloqueios(corpo, ir);
  if (aba === 'confiancas') return confiancas(corpo);
  return carregar(corpo, () => api.get('/cobranca/inadimplencia'), (d) => desenharInadimplencia(d, ir));
}

function desenharInadimplencia(r, ir) {
  const faixas = Object.entries(r.faixas);
  return [
    el('div', { class: 'stats' },
      stat({ rotulo: 'Saldo vencido', valor: dinheiro(r.saldo_centavos), nota: `${numero(r.faturas)} fatura(s) vencida(s)`, ic: 'alerta', semDado: !r.faturas }),
      stat({ rotulo: 'Total devido', valor: dinheiro(r.devido_centavos), nota: 'Com multa e juros de hoje', ic: 'dinheiro' }),
      stat({ rotulo: 'Taxa de inadimplência', valor: porcento(r.taxa_pct), nota: 'Vencido sobre o faturado em 12 meses', ic: 'atividade' }),
      stat({ rotulo: 'Devedores', valor: numero(r.devedores.length), nota: `${numero(r.devedores.filter((d) => d.bloqueado).length)} com serviço bloqueado`, ic: 'pessoa' })),
    painel('Por faixa de atraso', tabela([
      { titulo: 'Faixa (dias)', valor: ([k]) => k },
      { titulo: 'Faturas', valor: ([, v]) => numero(v.faturas), classe: 'num' },
      { titulo: 'Saldo', valor: ([, v]) => dinheiro(v.saldo_centavos), classe: 'num' },
    ], faixas, { vazioTexto: 'Nada vencido.' }), { semCorpo: true }),
    painel('Devedores', tabela([
      { titulo: 'Assinante', valor: (d) => el('div', {}, el('div', { class: 'forte' }, `${d.codigo} · ${d.nome}`), el('div', { class: 'fraco' }, telefone(d.telefone))) },
      { titulo: 'Faturas', valor: (d) => numero(d.faturas), classe: 'num' },
      { titulo: 'Saldo', valor: (d) => dinheiro(d.saldo_centavos), classe: 'num' },
      { titulo: 'Devido', valor: (d) => dinheiro(d.devido_centavos), classe: 'num' },
      { titulo: 'Maior atraso', valor: (d) => `${numero(d.atraso_dias)} dia(s)`, classe: 'num' },
      { titulo: 'Serviço', valor: (d) => (d.bloqueado ? etq('Bloqueado', 'erro') : etq('Ativo', 'ok')) },
    ], r.devedores, { vazioTexto: 'Nenhum devedor: nada vencido em aberto.', aoClicar: (d) => ir(`#/assinantes/${d.assinante_id}`) }), {
      semCorpo: true,
      acoes: [botao('CSV', () => baixar('/cobranca/inadimplencia/csv', 'inadimplencia.csv'), { tipo: 'secundario pequeno', ic: 'baixar' })],
    }),
  ];
}

function desenharRegras({ regras, carencia_organizacao: carencia }, recarregar) {
  const ativas = regras.filter((r) => r.ativa);
  const aposentadas = regras.filter((r) => !r.ativa);
  const linha = (r) => [
    { titulo: 'Quando', valor: (x) => el('div', {}, el('div', { class: 'forte' }, x.dias < 0 ? `${Math.abs(x.dias)} dia(s) antes do vencimento`
      : x.dias === 0 ? 'No dia do vencimento' : `${x.dias} dia(s) de atraso`), el('div', { class: 'fraco' }, x.nome)) },
    { titulo: 'Ação', valor: (x) => el('div', {}, rotulo('acaoRegua', x.acao),
      x.acao === 'bloquear' && x.dias < carencia ? el('div', { class: 'fraco' }, `só a partir da carência de ${carencia} dia(s)`) : null) },
    { titulo: 'Canal', valor: (x) => rotulo('canalRegua', x.canal) },
    { titulo: 'Versão', valor: (x) => el('div', {}, `v${x.versao}`, el('div', { class: 'fraco' }, `${numero(x.execucoes)} execução(ões)`)), classe: 'num' },
    ...(r === 'ativas' ? [{ titulo: '', valor: (x) => (pode('cobranca.regras')
      ? el('div', {}, el('button', { class: 'botao secundario pequeno', onclick: () => editarRegra(x, carencia, recarregar) }, 'Editar'), ' ',
        botao('Aposentar', async () => {
          if (!(await confirmar('Aposentar a regra', `A regra "${x.nome}" para de agir nas próximas execuções e continua no histórico explicando o que já fez.`, 'Aposentar'))) return;
          await api.post(`/cobranca/regras/${x.id}/desativar`);
          toast('Regra aposentada.');
          recarregar();
        }, { tipo: 'fantasma pequeno' }))
      : '') }] : [{ titulo: 'Substituída por', valor: (x) => (x.substituida_por ? `regra ${x.substituida_por}` : el('span', { class: 'fraco' }, 'Aposentada sem substituta')) }]),
  ];
  return [
    faixa(`A carência da operação é de ${carencia} dia(s) após o vencimento: nenhuma regra bloqueia antes disso, mesmo pedindo. A régua nunca executa a mesma regra duas vezes na mesma fatura.`, '', 'info'),
    painel('Regras em vigor', tabela(linha('ativas'), ativas, { vazioTexto: 'Nenhuma regra em vigor: a régua não faz nada.' }), {
      semCorpo: true,
      acoes: [pode('cobranca.regras') ? botao('Nova regra', () => editarRegra(null, carencia, recarregar), { tipo: 'secundario pequeno', ic: 'mais' }) : null],
    }),
    aposentadas.length ? painel('Versões aposentadas', tabela(linha('aposentadas'), aposentadas), { semCorpo: true }) : null,
  ];
}

function editarRegra(r, carencia, depois) {
  return formulario(r ? `Regra ${r.nome} (v${r.versao})` : 'Nova regra da régua', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: r?.nome, inteiro: true, ajuda: 'Aparece no bloqueio que a regra originar.' },
    { nome: 'dias', rotulo: 'Dias em relação ao vencimento', tipo: 'number', obrigatorio: true, valor: r?.dias,
      ajuda: 'Negativo = antes do vencimento, 0 = no dia, positivo = em atraso.' },
    { nome: 'acao', rotulo: 'Ação', tipo: 'select', obrigatorio: true, opcoes: opcoes('acaoRegua'), valor: r?.acao },
    { nome: 'canal', rotulo: 'Canal do aviso', tipo: 'select', vazio: false, opcoes: opcoes('canalRegua'), valor: r?.canal ?? 'sistema' },
    { nome: 'texto', rotulo: 'Texto do aviso', tipo: 'textarea', valor: r?.texto, inteiro: true, ajuda: 'Usado pela equipe ao despachar o aviso.' },
  ], {
    largo: true,
    antes: el('div', {},
      faixa(`Bloquear exige dias zero ou em atraso, e a carência de ${carencia} dia(s) prevalece sobre a regra.`, '', 'info'),
      r ? faixa('Salvar cria a versão seguinte: esta continua no histórico explicando o que já executou.', 'aviso', 'info') : null),
    enviar: async (d) => {
      const corpo = { ...d, dias: Number(d.dias) };
      const resp = r ? await api.patch(`/cobranca/regras/${r.id}`, corpo) : await api.post('/cobranca/regras', corpo);
      toast(resp.aviso ?? (r ? `Regra salva como v${resp.versao}.` : 'Regra criada.'));
      depois?.();
      return resp;
    },
  });
}

function avisos(corpo) {
  const lista = el('div');
  corpo.append(lista);
  function atualizar() {
    return carregar(lista, () => api.get('/cobranca/eventos?pendentes=1&por_pagina=100'), (l) => [
      faixa('A régua prepara o aviso; o envio sai pelo canal que a operação tiver contratado (e-mail ou WhatsApp). Marcar como enviado registra quem despachou e quando.', '', 'info'),
      painel(null, tabela([
        { titulo: 'Assinante', valor: (e) => el('div', {}, el('div', { class: 'forte' }, `${e.assinante_codigo} · ${e.assinante_nome}`),
          el('div', { class: 'fraco' }, [telefone(e.telefone), e.email].filter(Boolean).join(' · '))) },
        { titulo: 'Fatura', valor: (e) => el('div', {}, `#${e.fatura_numero} · ${dinheiro(e.valor_centavos - e.pago_centavos)}`,
          el('div', { class: 'fraco' }, `vence ${data(e.vencimento)}${e.dias_atraso > 0 ? ` · ${e.dias_atraso} dia(s) de atraso` : ''}`)) },
        { titulo: 'Regra', valor: (e) => el('div', {}, e.regra_nome, el('div', { class: 'fraco' }, rotulo('canalRegua', e.canal))) },
        { titulo: 'Texto', valor: (e) => (e.regra_texto ? el('details', {}, el('summary', {}, 'Ver texto'), el('p', { style: 'margin-top:8px' }, e.regra_texto))
          : el('span', { class: 'fraco' }, 'Sem texto na regra')) },
        { titulo: '', valor: (e) => (pode('cobranca.executar')
          ? botao('Marcar enviado', async () => { await api.post(`/cobranca/eventos/${e.id}/enviado`); toast('Aviso marcado como enviado.'); atualizar(); }, { tipo: 'secundario pequeno' })
          : '') },
      ], l.itens, { vazioTexto: 'Nenhum aviso aguardando envio.' }), { semCorpo: true }),
    ]);
  }
  atualizar();
}

function bloqueios(corpo, ir) {
  const filtro = { abertos: '1', pagina: 1 };
  const sel = el('select', { 'aria-label': 'Bloqueios' }, el('option', { value: '1' }, 'Em vigor'), el('option', { value: '0' }, 'Todo o histórico'));
  sel.addEventListener('change', () => { filtro.abertos = sel.value; filtro.pagina = 1; atualizar(); });
  const lista = el('div');
  corpo.append(el('div', { class: 'filtros' }, sel), lista);
  function atualizar() {
    return carregar(lista, () => api.get(`/cobranca/bloqueios${qs(filtro)}`), (l) => painel(null, tabela([
      { titulo: 'Assinante', valor: (b) => el('div', {}, el('div', { class: 'forte' }, `${b.assinante_codigo} · ${b.assinante_nome}`),
        el('div', { class: 'fraco' }, `contrato #${b.contrato_numero} · ${telefone(b.telefone)}`)) },
      { titulo: 'Motivo', valor: (b) => el('div', {}, rotulo('tipoBloqueio', b.tipo), el('div', { class: 'fraco' }, b.motivo)) },
      { titulo: 'Origem', valor: (b) => el('div', {}, rotulo('origemAcao', b.origem),
        el('div', { class: 'fraco' }, [b.regra_nome, b.fatura_numero ? `fatura #${b.fatura_numero}` : null, b.criado_por_nome].filter(Boolean).join(' · '))) },
      { titulo: 'Desde', valor: (b) => el('div', {}, dataHora(b.inicio), b.fim ? el('div', { class: 'fraco' }, `liberado ${dataHora(b.fim)}`) : null) },
      { titulo: 'Situação', valor: (b) => (b.fim ? etq('Liberado', 'ok') : etq('Em vigor', 'erro')) },
    ], l.itens, {
      vazioTexto: filtro.abertos === '1' ? 'Nenhum serviço bloqueado agora.' : 'Nenhum bloqueio no histórico.',
      aoClicar: (b) => ir(`#/contratos/${b.contrato_id}`),
      pagina: paginacao(l, (p) => { filtro.pagina = p; atualizar(); }),
    }), { semCorpo: true }));
  }
  atualizar();
}

function confiancas(corpo) {
  const lista = el('div');
  corpo.append(lista);
  carregar(lista, () => api.get('/cobranca/confiancas?por_pagina=100'), (l) => [
    faixa('O desbloqueio de confiança devolve o serviço por um prazo mesmo com a fatura em aberto. Terminado o prazo sem pagamento, a rotina diária bloqueia de novo sozinha.', '', 'info'),
    painel(null, tabela([
      { titulo: 'Assinante', valor: (c) => el('div', {}, el('div', { class: 'forte' }, `${c.assinante_codigo} · ${c.assinante_nome}`),
        el('div', { class: 'fraco' }, `contrato #${c.contrato_numero}`)) },
      { titulo: 'Prazo', valor: (c) => el('div', {}, `${data(c.inicio)} → ${data(c.ate)}`, c.motivo ? el('div', { class: 'fraco' }, c.motivo) : null) },
      { titulo: 'Concedida por', valor: (c) => c.concedida_por_nome ?? '—' },
      { titulo: 'Encerramento', valor: (c) => (c.encerrada_em ? el('div', {}, dataHora(c.encerrada_em)) : el('span', { class: 'fraco' }, '—')) },
      { titulo: 'Estado', valor: (c) => etqDe('estadoConfianca', c.estado) },
    ], l.itens, { vazioTexto: 'Nenhum desbloqueio de confiança concedido.' }), { semCorpo: true }),
  ]);
}

async function executar(depois) {
  const r = await formulario('Executar a régua de cobrança', [
    { nome: 'data', rotulo: 'Data de referência', tipo: 'date', valor: hoje(), ajuda: 'Normalmente hoje. Uma data passada serve para recuperar um dia em que a rotina não rodou.' },
  ], {
    rotuloEnviar: 'Executar',
    largo: true,
    antes: faixa('A rotina roda sozinha uma vez por dia. Executar à mão aqui não repete o que já foi feito: cada regra só alcança cada fatura uma vez.', '', 'info'),
    enviar: async (d) => {
      const execucao = await api.post('/cobranca/executar', d);
      const g = execucao.regua;
      toast(`Régua de ${data(execucao.hoje)}: ${g.avisos} aviso(s), ${g.bloqueios} bloqueio(s), ${g.indicacoes} indicação(ões), ${g.ignoradas} ignorada(s).`);
      return execucao;
    },
  });
  if (!r?.regua) return;
  await resultado(r);
  depois?.();
}

function resultado(r) {
  return formulario(`Régua de ${data(r.hoje)}`, [], {
    rotuloEnviar: 'Fechar',
    largo: true,
    antes: el('div', {},
      el('div', { class: 'stats' },
        stat({ rotulo: 'Avisos', valor: numero(r.regua.avisos), ic: 'sino' }),
        stat({ rotulo: 'Bloqueios', valor: numero(r.regua.bloqueios), ic: 'cadeado' }),
        stat({ rotulo: 'Indicações', valor: numero(r.regua.indicacoes), nota: 'Nenhum contrato foi cancelado', ic: 'info' }),
        stat({ rotulo: 'Confianças expiradas', valor: numero(r.confiancas.expiradas), nota: `${numero(r.confiancas.bloqueios)} voltaram a bloquear`, ic: 'relogio' })),
      r.regua.eventos.length
        ? painel('O que a régua fez', tabela([
          { titulo: 'Assinante', valor: (e) => e.assinante },
          { titulo: 'Fatura', valor: (e) => `#${e.fatura}` },
          { titulo: 'Regra', valor: (e) => el('div', {}, e.regra, el('div', { class: 'fraco' }, `${rotulo('acaoRegua', e.acao)} · ${e.dias_atraso} dia(s)`)) },
          { titulo: 'Resultado', valor: (e) => el('div', {}, etqDe('resultadoRegua', e.resultado), e.detalhe ? el('div', { class: 'fraco' }, e.detalhe) : null) },
        ], r.regua.eventos), { semCorpo: true })
        : vazio('A régua não encontrou nada a fazer nesta data.', 'Ou não há regra em vigor, ou tudo já foi tratado.')),
    enviar: async () => true,
  });
}
