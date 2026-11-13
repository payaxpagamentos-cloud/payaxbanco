'use strict';

/* Consultas usadas pelas duas áreas (backoffice e Internet Bank). O cliente_id é imposto pela rota do cliente. */
const { listaPaginada, like } = require('./http');
const { situacaoVisivel, valorAtualizado } = require('./boletos');
const { formatarNossoNumero } = require('./febraban');

const SELECT_BOLETO = `SELECT b.id, b.cliente_id, b.conta_id, b.nosso_numero, b.nosso_numero_dv, b.seu_numero, b.origem, b.tipo,
    b.pagador_nome, b.pagador_documento, b.valor_centavos, b.emissao, b.vencimento, b.situacao, b.erro_registro,
    b.linha_digitavel, b.codigo_barras, b.pix_txid, b.pago_em, b.pago_valor_centavos, b.baixado_em, b.ixc_receber_id,
    b.juros_mes_ppm, b.multa_ppm, b.desconto_centavos, b.desconto_ate, b.criado_em,
    c.razao_social, c.nome_fantasia
  FROM boletos b JOIN clientes c ON c.id = b.cliente_id`;

/** Lista de boletos com filtros. `situacao` aceita 'vencido' (registrado com vencimento passado). */
function listarBoletos(db, query, hoje, { clienteId = null } = {}) {
  const cond = [];
  const p = [];
  if (clienteId) { cond.push('b.cliente_id = ?'); p.push(clienteId); }
  else if (query.cliente_id) { cond.push('b.cliente_id = ?'); p.push(Number(query.cliente_id)); }
  if (query.situacao === 'vencido') { cond.push("b.situacao = 'registrado' AND b.vencimento < ?"); p.push(hoje); }
  else if (query.situacao === 'a_vencer') { cond.push("b.situacao = 'registrado' AND b.vencimento >= ?"); p.push(hoje); }
  else if (query.situacao) { cond.push('b.situacao = ?'); p.push(query.situacao); }
  if (query.tipo) { cond.push('b.tipo = ?'); p.push(query.tipo); }
  if (query.origem) { cond.push('b.origem = ?'); p.push(query.origem); }
  if (query.de) { cond.push(`b.${query.campo_data === 'pagamento' ? 'pago_em' : query.campo_data === 'emissao' ? 'emissao' : 'vencimento'} >= ?`); p.push(query.de); }
  if (query.ate) { cond.push(`b.${query.campo_data === 'pagamento' ? 'pago_em' : query.campo_data === 'emissao' ? 'emissao' : 'vencimento'} <= ?`); p.push(query.ate); }
  if (query.busca) {
    const t = String(query.busca).trim();
    const d = t.replace(/\D/g, '');
    cond.push(`(b.pagador_nome LIKE ? ESCAPE '\\' OR b.seu_numero LIKE ? ESCAPE '\\' OR b.nosso_numero LIKE ? OR b.pagador_documento = ? OR b.linha_digitavel LIKE ?)`);
    p.push(like(t), like(t), `%${d || '@'}%`, d, `%${d || '@'}%`);
  }
  const sql = `${SELECT_BOLETO}${cond.length ? ` WHERE ${cond.join(' AND ')}` : ''} ORDER BY b.vencimento DESC, b.id DESC`;
  const r = listaPaginada(db, sql, p, query, { padrao: 50, maximo: 200 });
  return {
    ...r,
    itens: r.itens.map((b) => ({
      ...b,
      situacao_visivel: situacaoVisivel(b, hoje),
      nosso_numero_formatado: formatarNossoNumero(b.nosso_numero, b.nosso_numero_dv),
      atualizado: valorAtualizado(b, hoje),
    })),
  };
}

/** Resumo de boletos por situação no período (cartões das telas). */
function resumoBoletos(db, { de, ate, clienteId = null, hoje }) {
  const p = clienteId ? [clienteId] : [];
  const onde = clienteId ? 'b.cliente_id = ? AND' : '';
  return db.prepare(`SELECT
      COUNT(*) AS emitidos,
      IFNULL(SUM(b.valor_centavos), 0) AS valor_emitido_centavos,
      SUM(CASE WHEN b.situacao = 'liquidado' THEN 1 ELSE 0 END) AS liquidados,
      IFNULL(SUM(CASE WHEN b.situacao = 'liquidado' THEN b.pago_valor_centavos ELSE 0 END), 0) AS valor_liquidado_centavos,
      SUM(CASE WHEN b.situacao = 'registrado' AND b.vencimento >= ? THEN 1 ELSE 0 END) AS a_vencer,
      SUM(CASE WHEN b.situacao = 'registrado' AND b.vencimento <  ? THEN 1 ELSE 0 END) AS vencidos,
      IFNULL(SUM(CASE WHEN b.situacao = 'registrado' AND b.vencimento < ? THEN b.valor_centavos ELSE 0 END), 0) AS valor_vencido_centavos,
      SUM(CASE WHEN b.situacao = 'baixado' THEN 1 ELSE 0 END) AS baixados,
      SUM(CASE WHEN b.situacao = 'falha' THEN 1 ELSE 0 END) AS falhas
    FROM boletos b WHERE ${onde} b.emissao BETWEEN ? AND ?`).get(hoje, hoje, hoje, ...p, de, ate);
}

/** O que entrou de fato no período (pelos títulos liquidados) e como foi dividido. */
function resumoLiquidacoes(db, { de, ate, clienteId = null }) {
  const p = clienteId ? [clienteId] : [];
  const onde = clienteId ? 'b.cliente_id = ? AND' : '';
  const r = db.prepare(`SELECT COUNT(*) AS titulos, IFNULL(SUM(b.pago_valor_centavos), 0) AS bruto_centavos
    FROM boletos b WHERE ${onde} b.situacao = 'liquidado' AND b.pago_em BETWEEN ? AND ?`).get(...p, de, ate);
  const l = db.prepare(`SELECT
      IFNULL(SUM(CASE WHEN l.tipo = 'comissao' THEN -l.valor_centavos ELSE 0 END), 0) AS comissao_centavos,
      IFNULL(SUM(CASE WHEN l.tipo = 'tarifa_banco' THEN -l.valor_centavos ELSE 0 END), 0) AS tarifa_banco_centavos,
      IFNULL(SUM(CASE WHEN l.tipo = 'tarifa_emissao' THEN -l.valor_centavos ELSE 0 END), 0) AS tarifa_emissao_centavos,
      IFNULL(SUM(CASE WHEN l.tipo = 'taxa_repasse' THEN -l.valor_centavos ELSE 0 END), 0) AS taxa_repasse_centavos,
      IFNULL(SUM(CASE WHEN l.tipo = 'repasse' THEN -l.valor_centavos ELSE 0 END), 0) AS repassado_centavos
    FROM lancamentos l WHERE ${clienteId ? 'l.cliente_id = ? AND' : ''} l.data_competencia BETWEEN ? AND ?`).get(...p, de, ate);
  const custo = db.prepare(`SELECT IFNULL(SUM(b.custo_liquidacao_centavos), 0) AS custo_centavos
    FROM boletos b WHERE ${onde} b.situacao = 'liquidado' AND b.pago_em BETWEEN ? AND ?`).get(...p, de, ate);
  const receita = l.comissao_centavos + l.tarifa_banco_centavos + l.tarifa_emissao_centavos + l.taxa_repasse_centavos;
  return {
    ...r, ...l,
    liquido_cliente_centavos: r.bruto_centavos - l.comissao_centavos - l.tarifa_banco_centavos,
    receita_centavos: receita,
    custo_banco_centavos: custo.custo_centavos,
    margem_centavos: receita - custo.custo_centavos,
  };
}

/** Entradas por dia, para o gráfico. */
const serieDiaria = (db, { de, ate, clienteId = null }) => db.prepare(`SELECT b.pago_em AS data,
    COUNT(*) AS titulos, IFNULL(SUM(b.pago_valor_centavos), 0) AS bruto_centavos
  FROM boletos b WHERE ${clienteId ? 'b.cliente_id = ? AND' : ''} b.situacao = 'liquidado' AND b.pago_em BETWEEN ? AND ?
  GROUP BY b.pago_em ORDER BY b.pago_em`).all(...(clienteId ? [clienteId] : []), de, ate);

/** Remove o custo com o banco e a margem de um resumo, para quem não tem permissão de ver a margem. */
const semMargem = (r) => ({ ...r, custo_banco_centavos: undefined, margem_centavos: undefined });

module.exports = { listarBoletos, resumoBoletos, resumoLiquidacoes, serieDiaria, semMargem, SELECT_BOLETO };

/** Boleto com a conta e o cliente, para a ficha de compensação e a tela de detalhe. */
function boletoCompleto(db, id, { clienteId = null } = {}) {
  const b = db.prepare('SELECT * FROM boletos WHERE id = ?').get(Number(id));
  if (!b || (clienteId && b.cliente_id !== clienteId)) return null;
  return {
    boleto: b,
    conta: db.prepare('SELECT * FROM contas_bancarias WHERE id = ?').get(b.conta_id),
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?').get(b.cliente_id),
    lancamentos: db.prepare('SELECT * FROM lancamentos WHERE boleto_id = ? ORDER BY id').all(b.id),
  };
}

module.exports.boletoCompleto = boletoCompleto;
