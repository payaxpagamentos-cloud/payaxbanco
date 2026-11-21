'use strict';

const { agora, proximoNumero } = require('../db');
const { ErroNegocio } = require('./erros');
const { diasEntre, dataBr, competenciaBr } = require('./datas');

/*
 * Motor de faturamento.
 *
 * Decisões que valem para todo o módulo:
 * - A competência é o mês do serviço ('AAAA-MM'); o vencimento é o dia escolhido no contrato (1 a 28, para existir
 *   em todo mês). Uma competência por contrato: rodar o ciclo duas vezes não cobra o assinante duas vezes.
 * - O valor da fatura é a soma dos itens no momento da emissão e não muda depois. Juros e multa são calculados no
 *   dia do pagamento e ficam registrados na baixa: nunca somados ao valor original.
 * - Pró-rata de entrada e de saída: o mês em que o contrato é ativado (ou cancelado) é cobrado pelos dias de serviço.
 *   Se o vencimento da competência já passou quando o contrato foi ativado, a pró-rata não é cobrada ali — ela entra
 *   na competência seguinte, como item próprio ao lado da mensalidade, porque cobrar num vencimento passado só
 *   produziria uma fatura nascida em atraso.
 * - Mês cujo total fica zero ou negativo (desconto maior que a mensalidade) não gera fatura: o desconto não vira
 *   crédito silencioso; o contrato aparece na lista de pulados com o motivo.
 */

const COMPETENCIA = /^\d{4}-(0[1-9]|1[0-2])$/;

const competenciaValida = (c) => COMPETENCIA.test(String(c ?? ''));
const diasNoMes = (c) => new Date(Date.UTC(Number(c.slice(0, 4)), Number(c.slice(5, 7)), 0)).getUTCDate();
const primeiroDia = (c) => `${c}-01`;
const ultimoDia = (c) => `${c}-${String(diasNoMes(c)).padStart(2, '0')}`;
const competenciaDe = (data) => String(data).slice(0, 7);
const vencimentoDe = (c, dia) => `${c}-${String(dia).padStart(2, '0')}`;

/** Competência deslocada em n meses (n pode ser negativo). */
function somarMeses(c, n) {
  const mes = Number(c.slice(5, 7)) - 1 + n;
  const ano = Number(c.slice(0, 4)) + Math.floor(mes / 12);
  return `${ano}-${String((mes % 12 + 12) % 12 + 1).padStart(2, '0')}`;
}

/** Percentual guardado em centésimos de ponto (200 = 2,00%) aplicado a um valor em centavos. */
const aplicarPct = (centavos, pctCentesimos) => Math.round((centavos * pctCentesimos) / 10_000);

/**
 * Valor proporcional aos dias de serviço dentro da competência. O dia inicial e o dia final contam
 * (um contrato ativado no último dia do mês paga um dia).
 */
function proporcional(mensalidadeCentavos, competencia, de, ate) {
  const inicio = de > primeiroDia(competencia) ? de : primeiroDia(competencia);
  const fim = ate && ate < ultimoDia(competencia) ? ate : ultimoDia(competencia);
  const total = diasNoMes(competencia);
  const dias = Math.max(0, Math.min(total, diasEntre(inicio, fim) + 1));
  return { valor_centavos: Math.round((mensalidadeCentavos * dias) / total), dias, dias_mes: total, de: inicio, ate: fim };
}

/** Esta origem já foi cobrada neste contrato em alguma fatura que não foi cancelada? */
const jaCobrado = (db, contratoId, origem) => Boolean(db.prepare(`SELECT 1 FROM fatura_itens i JOIN faturas f ON f.id = i.fatura_id
  WHERE i.contrato_id = ? AND i.origem = ? AND f.situacao <> 'cancelada' LIMIT 1`).get(contratoId, origem));

/** Já existe fatura (não cancelada) deste contrato nesta competência? */
const jaFaturado = (db, contratoId, competencia) => Boolean(db.prepare(`SELECT 1 FROM faturas
  WHERE contrato_id = ? AND competencia = ? AND situacao <> 'cancelada' LIMIT 1`).get(contratoId, competencia));

/**
 * Itens que o contrato gera na competência, ou o motivo de ficar fora dela.
 * Devolve { itens, total_centavos, motivo }: com motivo preenchido, o contrato não entra no ciclo.
 */
function itensDoCiclo(db, org, contrato, competencia) {
  const fora = (motivo) => ({ itens: [], total_centavos: 0, motivo });
  if (contrato.situacao === 'em_implantacao' || !contrato.ativacao) return fora('Contrato ainda não ativado.');
  if (contrato.situacao === 'suspenso') return fora('Contrato suspenso a pedido: não fatura.');
  if (contrato.ativacao > ultimoDia(competencia)) return fora(`Ativado em ${dataBr(contrato.ativacao)}, depois desta competência.`);
  if (contrato.situacao === 'cancelado' && contrato.cancelado_em && competenciaDe(contrato.cancelado_em) < competencia) {
    return fora(`Cancelado em ${dataBr(contrato.cancelado_em)}, antes desta competência.`);
  }
  if (jaFaturado(db, contrato.id, competencia)) return fora('Já faturado nesta competência.');

  const itens = [];
  const vencimento = vencimentoDe(competencia, contrato.dia_vencimento);
  const entrouAgora = competenciaDe(contrato.ativacao) === competencia;
  const saiuAgora = contrato.situacao === 'cancelado' && contrato.cancelado_em && competenciaDe(contrato.cancelado_em) === competencia;
  const proRataLigada = org.pro_rata === 1;

  if ((entrouAgora || saiuAgora) && proRataLigada) {
    // Mês de entrada e/ou de saída: cobra os dias de serviço, não o mês inteiro.
    const p = proporcional(contrato.mensalidade_centavos, competencia, contrato.ativacao, saiuAgora ? contrato.cancelado_em : null);
    // Vencimento já passado quando o contrato entrou: a pró-rata vai para a competência seguinte (a não ser que o
    // contrato também tenha sido cancelado neste mês — aí não haveria competência seguinte para cobrá-la).
    const adiar = entrouAgora && !saiuAgora && vencimento < contrato.ativacao;
    if (!adiar && p.dias > 0) {
      itens.push({ origem: 'pro_rata', descricao: `Mensalidade proporcional · ${p.dias} de ${p.dias_mes} dia(s)`,
        valor_centavos: p.valor_centavos, referencia: `periodo:${p.de}..${p.ate}` });
    }
  } else {
    // Mês cheio de serviço (e, com a pró-rata desligada, também o mês de entrada ou de saída).
    itens.push({ origem: 'mensalidade', descricao: `Mensalidade ${competenciaBr(competencia)}`, valor_centavos: contrato.mensalidade_centavos, referencia: `competencia:${competencia}` });
    const compAtivacao = competenciaDe(contrato.ativacao);
    if (proRataLigada && compAtivacao < competencia && !jaCobrado(db, contrato.id, 'pro_rata') && !jaFaturado(db, contrato.id, compAtivacao)) {
      // Pró-rata adiada do mês de ativação: o vencimento de lá já havia passado e aquele mês não gerou fatura.
      const p = proporcional(contrato.mensalidade_centavos, compAtivacao, contrato.ativacao, null);
      if (p.dias > 0) {
        itens.push({ origem: 'pro_rata', descricao: `Mensalidade proporcional de ${dataBr(p.de)} a ${dataBr(p.ate)} · ${p.dias} de ${p.dias_mes} dia(s)`,
          valor_centavos: p.valor_centavos, referencia: `periodo:${p.de}..${p.ate}` });
      }
    }
  }

  if (contrato.instalacao_centavos > 0 && !jaCobrado(db, contrato.id, 'instalacao')) {
    itens.push({ origem: 'instalacao', descricao: 'Taxa de instalação', valor_centavos: contrato.instalacao_centavos, referencia: `contrato:${contrato.id}` });
  }

  // Serviços e descontos fixos vigentes na competência.
  const fixos = db.prepare(`SELECT * FROM contrato_itens WHERE contrato_id = ? AND inicio <= ? AND (fim IS NULL OR fim >= ?) ORDER BY id`)
    .all(contrato.id, competencia, competencia);
  for (const f of fixos) {
    itens.push({ origem: f.tipo === 'desconto' ? 'desconto' : f.tipo, descricao: f.descricao, valor_centavos: f.valor_centavos, referencia: `contrato_item:${f.id}` });
  }

  const total = itens.reduce((s, i) => s + i.valor_centavos, 0);
  if (!itens.length) return fora('Nada a cobrar nesta competência.');
  if (total <= 0) return fora(`Total da competência ficaria em ${(total / 100).toFixed(2)}: fatura não emitida.`);
  return { itens, total_centavos: total, vencimento, motivo: null };
}

/**
 * Gera (ou simula) o faturamento de uma competência. A simulação não grava nada e não consome números de fatura,
 * então pode ser repetida à vontade antes de efetivar.
 */
function gerarCiclo(db, { org, competencia, simulacao = false, usuarioId = null }) {
  if (!competenciaValida(competencia)) throw new ErroNegocio('Competência inválida (use AAAA-MM).', 422);
  const organizacao = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(org);
  if (!simulacao && db.prepare('SELECT 1 FROM ciclos WHERE organizacao_id = ? AND competencia = ?').get(org, competencia)) {
    throw new ErroNegocio(`A competência ${competenciaBr(competencia)} já foi faturada. Use a simulação para conferir o que mudaria.`, 409);
  }
  const contratos = db.prepare(`SELECT c.*, a.nome AS assinante_nome, a.codigo AS assinante_codigo FROM contratos c JOIN assinantes a ON a.id = c.assinante_id
    WHERE c.organizacao_id = ? ORDER BY c.numero`).all(org);

  const previstas = [];
  const pulados = [];
  for (const c of contratos) {
    const r = itensDoCiclo(db, organizacao, c, competencia);
    if (r.motivo) { pulados.push({ contrato_id: c.id, numero: c.numero, assinante: c.assinante_nome, motivo: r.motivo }); continue; }
    previstas.push({ contrato: c, ...r });
  }
  const total = previstas.reduce((s, p) => s + p.total_centavos, 0);
  const resumo = { competencia, simulacao, faturas: previstas.length, valor_centavos: total, pulados };
  if (simulacao) {
    return { ...resumo, previsao: previstas.map((p) => ({ contrato_id: p.contrato.id, numero: p.contrato.numero, assinante: p.contrato.assinante_nome,
      vencimento: p.vencimento, valor_centavos: p.total_centavos, itens: p.itens })) };
  }

  const t = agora();
  const cicloId = Number(db.prepare('INSERT INTO ciclos (organizacao_id, competencia, faturas, valor_centavos, pulados, executado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(org, competencia, previstas.length, total, JSON.stringify(pulados), usuarioId, t).lastInsertRowid);
  const emitidas = [];
  for (const p of previstas) {
    emitidas.push(emitirFatura(db, { org, assinanteId: p.contrato.assinante_id, contratoId: p.contrato.id, competencia, cicloId,
      vencimento: p.vencimento, itens: p.itens, usuarioId, em: t }));
  }
  return { ...resumo, ciclo_id: cicloId, emitidas: emitidas.map((f) => f.id) };
}

/** Grava uma fatura com os itens. O valor é a soma dos itens. */
function emitirFatura(db, { org, assinanteId, contratoId = null, competencia = null, cicloId = null, vencimento, itens, observacoes = null, usuarioId = null, em = agora() }) {
  const valor = itens.reduce((s, i) => s + i.valor_centavos, 0);
  if (valor <= 0) throw new ErroNegocio('A fatura precisa somar mais que zero.', 422);
  const numero = proximoNumero(db, org, 'fatura');
  const id = Number(db.prepare(`INSERT INTO faturas (organizacao_id, assinante_id, contrato_id, numero, competencia, ciclo_id, vencimento, valor_centavos,
    observacoes, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(org, assinanteId, contratoId, numero, competencia, cicloId, vencimento, valor, observacoes, usuarioId, em).lastInsertRowid);
  const ins = db.prepare('INSERT INTO fatura_itens (organizacao_id, fatura_id, contrato_id, descricao, origem, valor_centavos, referencia) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const i of itens) ins.run(org, id, i.contrato_id ?? contratoId, i.descricao, i.origem, i.valor_centavos, i.referencia ?? null);
  return { id, numero, valor_centavos: valor, vencimento };
}

/**
 * Multa e juros de uma fatura em atraso, calculados para o dia informado.
 * Multa única sobre o saldo; juros ao mês pro rata die. Fatura paga, cancelada ou dentro do prazo não tem encargo.
 */
function encargos(fatura, organizacao, hoje) {
  const saldo = Math.max(0, fatura.valor_centavos - fatura.pago_centavos);
  const dias = diasEntre(fatura.vencimento, hoje);
  const base = { saldo_centavos: saldo, dias_atraso: Math.max(0, dias), multa_centavos: 0, juros_centavos: 0, total_devido_centavos: saldo };
  if (saldo === 0 || fatura.situacao === 'cancelada' || fatura.situacao === 'paga' || dias <= 0) return base;
  const multa = aplicarPct(saldo, organizacao.multa_atraso_pct_centesimos);
  const juros = Math.round((aplicarPct(saldo, organizacao.juros_mes_pct_centesimos) * dias) / 30);
  return { ...base, multa_centavos: multa, juros_centavos: juros, total_devido_centavos: saldo + multa + juros };
}

/** Recalcula pago, situação e data de quitação a partir dos pagamentos não estornados. */
function recalcular(db, faturaId) {
  const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(faturaId);
  const r = db.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS pago, MAX(data) AS ultima FROM pagamentos WHERE fatura_id = ? AND estornado_em IS NULL').get(faturaId);
  if (f.situacao === 'cancelada') {
    db.prepare('UPDATE faturas SET pago_centavos = ? WHERE id = ?').run(r.pago, faturaId);
    return db.prepare('SELECT * FROM faturas WHERE id = ?').get(faturaId);
  }
  const situacao = r.pago >= f.valor_centavos ? 'paga' : r.pago > 0 ? 'parcial' : 'aberta';
  db.prepare('UPDATE faturas SET pago_centavos = ?, situacao = ?, pago_em = ?, versao = versao + 1 WHERE id = ?')
    .run(r.pago, situacao, situacao === 'paga' ? r.ultima : null, faturaId);
  return db.prepare('SELECT * FROM faturas WHERE id = ?').get(faturaId);
}

/**
 * Registra uma baixa. `valor_centavos` abate o principal; juros, multa e desconto ficam em campos próprios e não
 * mexem no valor da fatura. Pagar mais que o saldo é recusado com o saldo na mensagem (crédito em conta não existe aqui).
 */
function registrarPagamento(db, { org, fatura, dados, usuarioId = null }) {
  if (fatura.situacao === 'cancelada') throw new ErroNegocio('Fatura cancelada não recebe baixa.', 422);
  if (fatura.situacao === 'paga') throw new ErroNegocio('Fatura já quitada.', 422);
  const saldo = fatura.valor_centavos - fatura.pago_centavos;
  if (dados.valor_centavos > saldo) {
    throw new ErroNegocio(`O valor abate mais que o saldo da fatura (saldo de R$ ${(saldo / 100).toFixed(2)}). Juros e multa vão nos campos de encargos.`, 422);
  }
  const id = Number(db.prepare(`INSERT INTO pagamentos (organizacao_id, fatura_id, valor_centavos, juros_centavos, multa_centavos, desconto_centavos, data, forma,
    origem, observacoes, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(org, fatura.id, dados.valor_centavos, dados.juros_centavos ?? 0, dados.multa_centavos ?? 0, dados.desconto_centavos ?? 0, dados.data, dados.forma,
      dados.origem ?? 'manual', dados.observacoes ?? null, usuarioId, agora()).lastInsertRowid);
  return { pagamento_id: id, fatura: recalcular(db, fatura.id) };
}

/** Estorna uma baixa (o registro fica, com quem estornou e por quê) e recalcula a fatura. */
function estornarPagamento(db, { pagamento, motivo, usuarioId = null }) {
  if (pagamento.estornado_em) throw new ErroNegocio('Este pagamento já foi estornado.', 422);
  db.prepare('UPDATE pagamentos SET estornado_em = ?, motivo_estorno = ?, estornado_por = ? WHERE id = ?').run(agora(), motivo, usuarioId, pagamento.id);
  return recalcular(db, pagamento.fatura_id);
}

/** Cancela a fatura. Só é possível sem nenhuma baixa em vigor: estorne os pagamentos antes. */
function cancelarFatura(db, { fatura, motivo, usuarioId = null }) {
  if (fatura.situacao === 'cancelada') throw new ErroNegocio('Fatura já cancelada.', 422);
  const pagos = db.prepare('SELECT COUNT(*) AS n FROM pagamentos WHERE fatura_id = ? AND estornado_em IS NULL').get(fatura.id).n;
  if (pagos) throw new ErroNegocio(`Esta fatura tem ${pagos} pagamento(s) em vigor. Estorne a baixa antes de cancelar.`, 422);
  db.prepare("UPDATE faturas SET situacao = 'cancelada', cancelada_em = ?, motivo_cancelamento = ?, cancelada_por = ?, versao = versao + 1 WHERE id = ?")
    .run(agora(), motivo, usuarioId, fatura.id);
  return db.prepare('SELECT * FROM faturas WHERE id = ?').get(fatura.id);
}

/** Faturas em aberto (ou parciais) do contrato, da mais antiga para a mais nova. */
const abertasDoContrato = (db, contratoId) => db.prepare(`SELECT * FROM faturas WHERE contrato_id = ? AND situacao IN ('aberta','parcial') ORDER BY vencimento`).all(contratoId);

/** Saldo em aberto e o atraso mais antigo do contrato. */
function posicaoDoContrato(db, contratoId, hoje) {
  const abertas = abertasDoContrato(db, contratoId);
  const saldo = abertas.reduce((s, f) => s + (f.valor_centavos - f.pago_centavos), 0);
  const vencidas = abertas.filter((f) => f.vencimento < hoje);
  return { abertas: abertas.length, saldo_centavos: saldo, vencidas: vencidas.length,
    atraso_dias: vencidas.length ? diasEntre(vencidas[0].vencimento, hoje) : 0, mais_antiga: vencidas[0]?.vencimento ?? null };
}

module.exports = { COMPETENCIA, competenciaValida, competenciaDe, diasNoMes, primeiroDia, ultimoDia, vencimentoDe, somarMeses, aplicarPct, proporcional,
  itensDoCiclo, gerarCiclo, emitirFatura, encargos, recalcular, registrarPagamento, estornarPagamento, cancelarFatura, abertasDoContrato, posicaoDoContrato };
