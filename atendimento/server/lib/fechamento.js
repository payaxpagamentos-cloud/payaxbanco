'use strict';

const { agora, transacao } = require('../db');
const { hoje, somarDias } = require('./datas');
const { ErroNegocio, naoEncontrado } = require('./erros');
const custo = require('./custo');
const orcamento = require('./orcamento');
const v = require('./validacao');

/**
 * O fechamento do mês — onde o número para de ser estimativa.
 *
 * Durante o mês a tela soma as mensagens uma a uma. No dia 1º o mês anterior é fechado numa
 * linha que não muda mais: quantas mensagens, por categoria, o que foi gasto, o que deixou de
 * ser gasto e qual era o orçamento. Depois a gestão lança o valor que a Meta cobrou de verdade
 * e o sistema mostra a diferença.
 *
 * Essa conferência é o que separa um painel bonito de um controle de custo. Se a nossa conta e
 * a fatura da Meta divergirem, ou o preço cadastrado está velho, ou mensagem está saindo por
 * fora do sistema — e nos dois casos a gestão precisa saber, não descobrir no extrato.
 */

const mesAnterior = (ref = hoje()) => somarDias(`${ref.slice(0, 7)}-01`, -1).slice(0, 7);
const ehMesValido = (mes) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes));

/**
 * Fecha um mês. Idempotente: fechar de novo recalcula, a menos que a fatura da Meta já tenha
 * sido lançada — a partir daí a linha está conferida e não se mexe mais nela.
 */
function fechar(db, empresaId, mes = mesAnterior()) {
  v.exigir(ehMesValido(mes), 'Informe o mês no formato AAAA-MM.');
  v.exigir(mes <= hoje().slice(0, 7), 'Não é possível fechar um mês que ainda não começou.');
  const existente = db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes);
  if (existente?.conferido_em) return { ...publico(existente), recalculado: false };

  const inicio = `${mes}-01`;
  const fim = `${somarDias(inicio, 31).slice(0, 7)}-01`;
  const r = custo.resumo(db, empresaId, { de: inicio, ate: somarDias(fim, -1) });
  const e = db.prepare('SELECT orcamento_milesimos FROM empresas WHERE id = ?').get(empresaId);

  const linha = transacao(db, () => {
    db.prepare(`INSERT INTO custos_mensais
        (empresa_id, mes, mensagens, por_categoria, gasto_milesimos, economia_milesimos, sem_otimizacao_milesimos, orcamento_milesimos,
         moeda, gasto_usd_micro, cotacao_x10000, fechado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (empresa_id, mes) DO UPDATE SET
        mensagens = excluded.mensagens, por_categoria = excluded.por_categoria,
        gasto_milesimos = excluded.gasto_milesimos, economia_milesimos = excluded.economia_milesimos,
        sem_otimizacao_milesimos = excluded.sem_otimizacao_milesimos,
        orcamento_milesimos = excluded.orcamento_milesimos, moeda = excluded.moeda,
        gasto_usd_micro = excluded.gasto_usd_micro, cotacao_x10000 = excluded.cotacao_x10000, fechado_em = excluded.fechado_em`)
      .run(empresaId, mes, r.mensagens, JSON.stringify(r.por_categoria), r.gasto_milesimos,
        r.economia_milesimos, r.sem_otimizacao_milesimos, Number(e?.orcamento_milesimos ?? 0),
        r.moeda, r.gasto_usd_micro, r.cotacao_x10000, agora());
    return db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes);
  });
  return { ...publico(linha), recalculado: Boolean(existente) };
}

/**
 * Lança o valor que a Meta cobrou e congela o mês. Em centavos, como vem na fatura.
 * Conta em dólar: `valor_usd_centavos` é a fatura (é com ela que se confere a nossa conta), e
 * `valor_centavos`, opcional, é o que saiu de fato da conta em reais — com IOF e spread.
 */
function conferir(db, empresaId, mes, { valor_centavos = null, valor_usd_centavos = null, observacao = null, usuario = null }) {
  v.exigir(ehMesValido(mes), 'Informe o mês no formato AAAA-MM.');
  const linha = db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes)
    ?? (fechar(db, empresaId, mes) && db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes));
  if (!linha) throw naoEncontrado('Fechamento do mês');
  const reais = valor_centavos === null || valor_centavos === undefined || valor_centavos === ''
    ? null : v.inteiro(valor_centavos, 'o valor debitado em reais', { min: 0, max: 100_000_000 });
  let dolares = null;
  if (linha.moeda === 'USD') {
    // Sem isto, um campo vazio virava US$ 0,00 e o mês ficava "conferido" sem ninguém digitar nada.
    v.exigir(valor_usd_centavos !== null && valor_usd_centavos !== undefined && valor_usd_centavos !== '', 'Informe o valor da fatura da Meta em dólar.');
    dolares = v.inteiro(valor_usd_centavos, 'o valor da fatura da Meta em dólar', { min: 0, max: 100_000_000 });
  } else {
    v.exigir(reais !== null, 'Informe o valor da fatura da Meta.');
  }
  db.prepare(`UPDATE custos_mensais SET fatura_meta_centavos = ?, fatura_meta_usd_centavos = ?, observacao = ?,
      conferido_em = ?, conferido_por = ? WHERE id = ?`)
    .run(reais, dolares, v.opcional(observacao, 'a observação', 1000), agora(), usuario?.nome ?? null, linha.id);
  return publico(db.prepare('SELECT * FROM custos_mensais WHERE id = ?').get(linha.id));
}

/** Abre um mês já conferido para lançar de novo (erro de digitação na fatura, por exemplo). */
function reabrir(db, empresaId, mes) {
  const linha = db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes);
  if (!linha) throw naoEncontrado('Fechamento do mês');
  if (!linha.conferido_em) throw new ErroNegocio('Este mês ainda não foi conferido.');
  db.prepare('UPDATE custos_mensais SET fatura_meta_centavos = NULL, fatura_meta_usd_centavos = NULL, conferido_em = NULL, conferido_por = NULL WHERE id = ?').run(linha.id);
  return fechar(db, empresaId, mes);
}

/** A linha como o painel e o Manager a leem, já com a diferença calculada. */
function publico(l) {
  if (!l) return null;
  const nosso = Math.round(Number(l.gasto_milesimos) / 10); // milésimos de real → centavos
  const meta = l.fatura_meta_centavos === null || l.fatura_meta_centavos === undefined ? null : Number(l.fatura_meta_centavos);
  const emDolar = l.moeda === 'USD';
  if (emDolar) return publicoEmDolar(l, nosso, meta);
  return {
    moeda: 'BRL',
    mes: l.mes,
    mensagens: Number(l.mensagens),
    por_categoria: (() => { try { return JSON.parse(l.por_categoria); } catch { return []; } })(),
    gasto_milesimos: Number(l.gasto_milesimos),
    gasto_centavos: nosso,
    economia_milesimos: Number(l.economia_milesimos),
    sem_otimizacao_milesimos: Number(l.sem_otimizacao_milesimos),
    orcamento_milesimos: Number(l.orcamento_milesimos),
    estourou_orcamento: Boolean(l.orcamento_milesimos && Number(l.gasto_milesimos) > Number(l.orcamento_milesimos)),
    fatura_meta_centavos: meta,
    diferenca_centavos: meta === null ? null : meta - nosso,
    // Mais de 5% de diferença não é arredondamento: é preço velho ou mensagem saindo por fora.
    divergente: meta === null ? null : Math.abs(meta - nosso) > Math.max(100, Math.round(nosso * 0.05)),
    conferido_em: l.conferido_em,
    conferido_por: l.conferido_por,
    observacao: l.observacao,
    fechado_em: l.fechado_em,
  };
}

/**
 * O mês de uma conta cobrada em dólar. A conferência é dólar contra dólar — a nossa conta exata
 * contra a fatura da Meta —, sem câmbio no meio: assim a diferença mostra erro de contagem ou de
 * preço, e não oscilação do dólar. O que saiu em reais aparece à parte, com o câmbio efetivo.
 */
function publicoEmDolar(l, nossoReais, debitado) {
  const nossoUsd = Math.round(Number(l.gasto_usd_micro ?? 0) / 10_000); // milionésimos → centavos de dólar
  const fatura = l.fatura_meta_usd_centavos === null || l.fatura_meta_usd_centavos === undefined ? null : Number(l.fatura_meta_usd_centavos);
  return {
    moeda: 'USD',
    mes: l.mes,
    mensagens: Number(l.mensagens),
    por_categoria: (() => { try { return JSON.parse(l.por_categoria); } catch { return []; } })(),
    gasto_milesimos: Number(l.gasto_milesimos),
    gasto_centavos: nossoReais,
    gasto_usd_centavos: nossoUsd,
    economia_milesimos: Number(l.economia_milesimos),
    sem_otimizacao_milesimos: Number(l.sem_otimizacao_milesimos),
    orcamento_milesimos: Number(l.orcamento_milesimos),
    estourou_orcamento: Boolean(l.orcamento_milesimos && Number(l.gasto_milesimos) > Number(l.orcamento_milesimos)),
    cotacao_x10000: l.cotacao_x10000 === null ? null : Number(l.cotacao_x10000),
    fatura_meta_usd_centavos: fatura,
    diferenca_usd_centavos: fatura === null ? null : fatura - nossoUsd,
    // Acima de 5% (ou de US$ 1) não é arredondamento: é preço velho ou mensagem saindo por fora.
    divergente: fatura === null ? null : Math.abs(fatura - nossoUsd) > Math.max(100, Math.round(nossoUsd * 0.05)),
    // O que saiu de fato da conta da empresa, e o dólar que ficou pago — com IOF e spread.
    fatura_meta_centavos: debitado,
    cambio_efetivo: debitado !== null && fatura ? Math.round((debitado / fatura) * 10_000) / 10_000 : null,
    diferenca_centavos: null,
    conferido_em: l.conferido_em,
    conferido_por: l.conferido_por,
    observacao: l.observacao,
    fechado_em: l.fechado_em,
  };
}

/** Os últimos N meses fechados, do mais recente para o mais antigo, com o mês corrente em aberto. */
function serie(db, empresaId, { meses = 12 } = {}) {
  const fechados = db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? ORDER BY mes DESC LIMIT ?')
    .all(empresaId, Math.min(60, Math.max(1, Number(meses)))).map(publico);
  const mesCorrente = hoje().slice(0, 7);
  const aberto = fechados.some((x) => x.mes === mesCorrente) ? null : (() => {
    const r = custo.resumo(db, empresaId, { de: `${mesCorrente}-01`, ate: hoje() });
    const o = orcamento.estado(db, empresaId);
    return {
      moeda: r.moeda, cotacao_x10000: r.cotacao_x10000,
      gasto_usd_centavos: r.gasto_usd_micro === null ? null : Math.round(r.gasto_usd_micro / 10_000),
      mes: mesCorrente, mensagens: r.mensagens, por_categoria: r.por_categoria,
      gasto_milesimos: r.gasto_milesimos, gasto_centavos: Math.round(r.gasto_milesimos / 10),
      economia_milesimos: r.economia_milesimos, sem_otimizacao_milesimos: r.sem_otimizacao_milesimos,
      orcamento_milesimos: o.orcamento_milesimos, estourou_orcamento: o.status === 'estourado',
      fatura_meta_centavos: null, diferenca_centavos: null, divergente: null,
      conferido_em: null, conferido_por: null, observacao: null, fechado_em: null,
      em_aberto: true, projecao_milesimos: o.projecao_milesimos,
    };
  })();
  return { meses: [...(aberto ? [aberto] : []), ...fechados] };
}

/** Fecha o mês anterior de todas as empresas ativas. Chamado pelo agendador no dia 1º. */
function fecharTodas(db, { mes = mesAnterior() } = {}) {
  const feitos = [];
  for (const e of db.prepare("SELECT id, nome FROM empresas WHERE status = 'ativa'").all()) {
    try { feitos.push({ empresa: e.nome, ...fechar(db, e.id, mes) }); } catch (err) { feitos.push({ empresa: e.nome, erro: err.message }); }
  }
  return feitos;
}

module.exports = { fechar, conferir, reabrir, serie, fecharTodas, mesAnterior, publico };
