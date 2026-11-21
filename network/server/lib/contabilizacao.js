'use strict';

const { transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const contabil = require('./contabil');

/*
 * Contabilização automática: o que o financeiro faz vira lançamento contábil sozinho.
 *
 * É o ponto do sistema que mais poupa trabalho — e o que mais exige cuidado, porque um erro aqui se
 * multiplica por milhares de faturas antes de alguém olhar.
 *
 * Três decisões sustentam isso:
 *
 * 1. CADA FATO TEM UMA CHAVE. "fatura:412" vira um lançamento e só um, ainda que a rotina rode dez vezes.
 *    Sem a chave, uma reexecução dobraria a receita do mês.
 *
 * 2. CONTABILIZAR NÃO BLOQUEIA O FINANCEIRO. Se o plano de contas não estiver mapeado, a fatura é
 *    emitida do mesmo jeito e o fato fica PENDENTE, visível numa lista. Travar o faturamento porque falta
 *    uma conta cadastrada seria parar o provedor por um problema de escritório.
 *
 * 3. O QUE NÃO FOI CONTABILIZADO APARECE. A conferência compara os fatos do financeiro com os lançamentos
 *    existentes e diz quantos faltam. Contabilização silenciosamente incompleta é pior que nenhuma: dá a
 *    impressão de que o balancete está pronto.
 */

/** Para onde vai a receita de cada tipo de item da fatura. */
const CONTA_DO_ITEM = {
  mensalidade: 'receita_mensalidade',
  pro_rata: 'receita_mensalidade',
  instalacao: 'receita_instalacao',
  sva: 'receita_sva',
  equipamento: 'receita_equipamento',
  ponto_adicional: 'receita_outros',
  avulso: 'receita_outros',
  outro: 'receita_outros',
  desconto: 'descontos_concedidos',
};

/** Dinheiro em espécie entra no caixa; o resto passa por banco. */
const CONTA_DA_FORMA = (forma) => (forma === 'dinheiro' ? 'caixa' : 'banco');

/** Chaves sem as quais nada pode ser contabilizado. */
const OBRIGATORIAS = ['clientes', 'caixa', 'banco', 'receita_mensalidade', 'receita_instalacao', 'receita_sva',
  'receita_equipamento', 'receita_outros', 'juros_recebidos', 'descontos_concedidos', 'cancelamentos'];

function exigirMapa(db, org) {
  const faltando = OBRIGATORIAS.filter((k) => !contabil.contaPadrao(db, org, k));
  if (faltando.length) {
    throw new ErroNegocio(`O plano de contas ainda não está mapeado: falta definir a conta de ${faltando.join(', ')}. `
      + 'Sem esse mapa, contabilizar seria adivinhar para onde o valor vai.', 422);
  }
  return Object.fromEntries(OBRIGATORIAS.map((k) => [k, contabil.contaPadrao(db, org, k)]));
}

const ligada = (db, org) => Boolean(db.prepare('SELECT contabilidade_automatica FROM organizacoes WHERE id = ?').get(org)?.contabilidade_automatica);

/* ---------------- Fatos ---------------- */

/**
 * Fatura emitida: o assinante passa a dever, e a receita é reconhecida na competência — não no
 * recebimento. É o regime de competência, que é o que a contabilidade exige.
 */
function contabilizarFatura(db, { org, faturaId, usuarioId = null }) {
  const f = db.prepare(`SELECT f.*, a.nome AS assinante_nome, a.codigo AS assinante_codigo
    FROM faturas f JOIN assinantes a ON a.id = f.assinante_id WHERE f.id = ? AND f.organizacao_id = ?`).get(Number(faturaId), org);
  if (!f) throw new ErroNegocio('Fatura não encontrada.', 404);
  if (f.situacao === 'cancelada') return { pulado: 'fatura cancelada' };
  const mapa = exigirMapa(db, org);
  const itens = db.prepare('SELECT * FROM fatura_itens WHERE fatura_id = ? ORDER BY id').all(f.id);
  if (!itens.length) return { pulado: 'fatura sem itens' };

  // Desconto é item de valor negativo: vira débito em "descontos concedidos", não crédito negativo.
  const creditos = new Map();
  const debitos = new Map();
  for (const i of itens) {
    const chave = CONTA_DO_ITEM[i.origem] ?? 'receita_outros';
    const alvo = i.valor_centavos < 0 ? debitos : creditos;
    const conta = i.valor_centavos < 0 ? mapa.descontos_concedidos : mapa[chave];
    alvo.set(conta.id, (alvo.get(conta.id) ?? 0) + Math.abs(i.valor_centavos));
  }
  const totalCredito = [...creditos.values()].reduce((s, v) => s + v, 0);
  const totalDebito = [...debitos.values()].reduce((s, v) => s + v, 0);
  const aReceber = totalCredito - totalDebito;
  if (aReceber <= 0) return { pulado: 'fatura sem valor a receber' };

  const partidas = [
    { conta_id: mapa.clientes.id, tipo: 'D', valor_centavos: aReceber, historico: `Fatura ${f.numero}` },
    ...[...creditos.entries()].map(([conta_id, valor_centavos]) => ({ conta_id, tipo: 'C', valor_centavos })),
    ...[...debitos.entries()].map(([conta_id, valor_centavos]) => ({ conta_id, tipo: 'D', valor_centavos })),
  ];
  return contabil.lancar(db, {
    org,
    data: f.criado_em.slice(0, 10),
    competencia: f.competencia || contabil.competenciaDe(f.criado_em),
    historico: `Fatura ${f.numero} · ${f.assinante_codigo} ${f.assinante_nome}`,
    origem: 'faturamento',
    origemTipo: 'fatura',
    origemId: f.id,
    chave: `fatura:${f.id}`,
    usuarioId,
    partidas,
  });
}

/**
 * Baixa recebida: o dinheiro entra e a dívida do assinante diminui.
 *
 * Juros e multa NÃO reduzem a dívida — são receita nova, de outra natureza. Jogá-los contra "clientes"
 * faria o saldo do assinante ficar negativo e a receita financeira desaparecer do resultado.
 */
function contabilizarPagamento(db, { org, pagamentoId, usuarioId = null }) {
  const p = db.prepare(`SELECT pg.*, f.numero AS fatura_numero, a.nome AS assinante_nome, a.codigo AS assinante_codigo
    FROM pagamentos pg JOIN faturas f ON f.id = pg.fatura_id JOIN assinantes a ON a.id = f.assinante_id
    WHERE pg.id = ? AND pg.organizacao_id = ?`).get(Number(pagamentoId), org);
  if (!p) throw new ErroNegocio('Pagamento não encontrado.', 404);
  const mapa = exigirMapa(db, org);
  const encargos = (p.juros_centavos ?? 0) + (p.multa_centavos ?? 0);
  const desconto = p.desconto_centavos ?? 0;
  const entrou = p.valor_centavos + encargos - desconto;
  if (entrou <= 0) return { pulado: 'baixa sem entrada de caixa' };

  const partidas = [
    { conta_id: mapa[CONTA_DA_FORMA(p.forma)].id, tipo: 'D', valor_centavos: entrou, historico: `Recebimento da fatura ${p.fatura_numero}` },
    { conta_id: mapa.clientes.id, tipo: 'C', valor_centavos: p.valor_centavos, historico: `Baixa da fatura ${p.fatura_numero}` },
  ];
  if (encargos) partidas.push({ conta_id: mapa.juros_recebidos.id, tipo: 'C', valor_centavos: encargos, historico: 'Juros e multa por atraso' });
  if (desconto) partidas.push({ conta_id: mapa.descontos_concedidos.id, tipo: 'D', valor_centavos: desconto, historico: 'Desconto concedido na baixa' });

  return contabil.lancar(db, {
    org,
    data: p.data,
    historico: `Recebimento da fatura ${p.fatura_numero} · ${p.assinante_codigo} ${p.assinante_nome}`,
    origem: 'recebimento',
    origemTipo: 'pagamento',
    origemId: p.id,
    chave: `pagamento:${p.id}`,
    usuarioId,
    partidas,
  });
}

/** Baixa estornada: desfaz o lançamento do recebimento, sem apagá-lo. */
function contabilizarEstornoPagamento(db, { org, pagamentoId, motivo, usuarioId = null }) {
  const original = db.prepare('SELECT * FROM lancamentos WHERE organizacao_id = ? AND chave = ?').get(org, `pagamento:${pagamentoId}`);
  if (!original) return { pulado: 'o recebimento não chegou a ser contabilizado' };
  if (original.estornado_por_id) return { pulado: 'já estornado' };
  return contabil.estornar(db, { org, lancamentoId: original.id, motivo: motivo || 'Baixa estornada no financeiro', usuarioId });
}

/** Fatura cancelada: desfaz o reconhecimento da receita. */
function contabilizarCancelamento(db, { org, faturaId, motivo, usuarioId = null }) {
  const original = db.prepare('SELECT * FROM lancamentos WHERE organizacao_id = ? AND chave = ?').get(org, `fatura:${faturaId}`);
  if (!original) return { pulado: 'a fatura não chegou a ser contabilizada' };
  if (original.estornado_por_id) return { pulado: 'já estornado' };
  return contabil.estornar(db, { org, lancamentoId: original.id, motivo: motivo || 'Fatura cancelada', usuarioId });
}

/* ---------------- Gatilho ---------------- */

/**
 * Chamado pelo financeiro depois de cada fato. Nunca derruba a operação: se a contabilização falhar, a
 * fatura continua emitida e o fato fica pendente, visível na conferência.
 */
function aoAcontecer(db, org, fato, dados) {
  if (!ligada(db, org)) return { pulado: 'contabilidade automática desligada' };
  try {
    const fn = { fatura: contabilizarFatura, pagamento: contabilizarPagamento,
      estorno_pagamento: contabilizarEstornoPagamento, cancelamento_fatura: contabilizarCancelamento }[fato];
    if (!fn) return { pulado: `fato desconhecido: ${fato}` };
    return fn(db, { org, ...dados });
  } catch (err) {
    // O erro fica no log do servidor e o fato aparece como pendente: ninguém descobre pelo balancete errado.
    console.warn(`[Network] Contabilização de ${fato} falhou: ${err.message}`);
    return { erro: err.message };
  }
}

/* ---------------- Conferência ---------------- */

/**
 * O que o financeiro registrou e a contabilidade ainda não tem.
 *
 * É a prova de que o balancete está completo — ou a lista do que falta. Sem ela, "contabilidade
 * automática ligada" seria uma promessa sem conferência.
 */
function pendencias(db, org, { limite = 200 } = {}) {
  const faturas = db.prepare(`SELECT f.id, f.numero, f.competencia, f.valor_centavos, f.criado_em, a.nome AS assinante_nome
    FROM faturas f JOIN assinantes a ON a.id = f.assinante_id
    WHERE f.organizacao_id = ? AND f.situacao <> 'cancelada'
      AND NOT EXISTS (SELECT 1 FROM lancamentos l WHERE l.organizacao_id = f.organizacao_id AND l.chave = 'fatura:' || f.id)
    ORDER BY f.id LIMIT ?`).all(org, limite);
  const pagamentos = db.prepare(`SELECT pg.id, pg.valor_centavos, pg.data, f.numero AS fatura_numero
    FROM pagamentos pg JOIN faturas f ON f.id = pg.fatura_id
    WHERE pg.organizacao_id = ? AND pg.estornado_em IS NULL
      AND NOT EXISTS (SELECT 1 FROM lancamentos l WHERE l.organizacao_id = pg.organizacao_id AND l.chave = 'pagamento:' || pg.id)
    ORDER BY pg.id LIMIT ?`).all(org, limite);
  const faltando = OBRIGATORIAS.filter((k) => !contabil.contaPadrao(db, org, k));
  return {
    ligada: ligada(db, org),
    mapa_completo: faltando.length === 0,
    contas_faltando: faltando,
    faturas,
    pagamentos,
    total: faturas.length + pagamentos.length,
    // O "limite" existe para a tela não travar; se bateu no teto, pode haver mais.
    pode_haver_mais: faturas.length === limite || pagamentos.length === limite,
  };
}

/** Contabiliza o que está pendente. Idempotente: rodar duas vezes não duplica nada. */
function contabilizarPendentes(db, org, { usuarioId = null, limite = 500 } = {}) {
  exigirMapa(db, org);
  const p = pendencias(db, org, { limite });
  const r = { faturas: 0, pagamentos: 0, pulados: 0, erros: [] };
  for (const f of p.faturas) {
    try {
      const x = transacao(db, () => contabilizarFatura(db, { org, faturaId: f.id, usuarioId }));
      if (x.pulado) r.pulados += 1; else r.faturas += 1;
    } catch (err) { r.erros.push({ tipo: 'fatura', numero: f.numero, erro: err.message }); }
  }
  for (const pg of p.pagamentos) {
    try {
      const x = transacao(db, () => contabilizarPagamento(db, { org, pagamentoId: pg.id, usuarioId }));
      if (x.pulado) r.pulados += 1; else r.pagamentos += 1;
    } catch (err) { r.erros.push({ tipo: 'pagamento', fatura: pg.fatura_numero, erro: err.message }); }
  }
  return r;
}

/** Liga a contabilização automática — só depois de o mapa estar completo. */
function ligar(db, org, { usuarioId = null } = {}) {
  exigirMapa(db, org);
  db.prepare('UPDATE organizacoes SET contabilidade_automatica = 1 WHERE id = ?').run(org);
  return { ligada: true, pendentes: pendencias(db, org).total, usuarioId };
}

const desligar = (db, org) => { db.prepare('UPDATE organizacoes SET contabilidade_automatica = 0 WHERE id = ?').run(org); return { ligada: false }; };

module.exports = {
  CONTA_DO_ITEM, CONTA_DA_FORMA, OBRIGATORIAS, exigirMapa, ligada,
  contabilizarFatura, contabilizarPagamento, contabilizarEstornoPagamento, contabilizarCancelamento,
  aoAcontecer, pendencias, contabilizarPendentes, ligar, desligar,
};
