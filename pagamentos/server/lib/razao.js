'use strict';

/*
 * Conta gráfica do cliente (razão).
 *
 * Regra de ouro: o saldo NUNCA é um campo guardado — é sempre a soma dos lançamentos.
 * Cada lançamento tem duas datas:
 *   - data_competencia: quando o fato aconteceu (a liquidação do boleto);
 *   - data_liberacao:  quando o dinheiro entra no saldo DISPONÍVEL (competência + retenção em dias úteis).
 *
 * Saldo disponível = soma dos lançamentos já liberados (inclui os repasses, que são negativos).
 * Saldo a liberar  = soma dos lançamentos com liberação no futuro.
 */
const { ErroNegocio } = require('./erros');
const { agora } = require('../db');

const TIPOS = {
  credito_liquidacao: 'Crédito de liquidação',
  tarifa_banco: 'Tarifa bancária',
  comissao: 'Tarifa PayAx',
  tarifa_emissao: 'Tarifa de emissão',
  repasse: 'Repasse ao cliente',
  taxa_repasse: 'Tarifa do repasse',
  estorno: 'Estorno',
  ajuste: 'Ajuste',
};

/** Grava um lançamento. Valor positivo credita o cliente; negativo debita. */
function lancar(db, { cliente_id, boleto_id = null, repasse_id = null, tipo, valor_centavos, descricao, data_competencia, data_liberacao, criado_por = null }) {
  if (!TIPOS[tipo]) throw new ErroNegocio(`Tipo de lançamento desconhecido: ${tipo}.`, 422);
  if (!Number.isInteger(valor_centavos)) throw new ErroNegocio('Valor do lançamento deve ser inteiro (centavos).', 422);
  if (valor_centavos === 0) return null;
  const r = db.prepare(`INSERT INTO lancamentos (cliente_id, boleto_id, repasse_id, tipo, valor_centavos, descricao, data_competencia, data_liberacao, criado_em, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(cliente_id, boleto_id, repasse_id, tipo, valor_centavos, descricao, data_competencia, data_liberacao ?? data_competencia, agora(), criado_por);
  return r.id;
}

const lancarLote = (db, lista) => lista.map((l) => lancar(db, l)).filter(Boolean);

/** Saldo do cliente na data (padrão: hoje). */
function saldo(db, clienteId, hoje) {
  const r = db.prepare(`SELECT
      IFNULL(SUM(CASE WHEN data_liberacao <= ? THEN valor_centavos ELSE 0 END), 0) AS disponivel,
      IFNULL(SUM(CASE WHEN data_liberacao  > ? THEN valor_centavos ELSE 0 END), 0) AS a_liberar,
      IFNULL(SUM(valor_centavos), 0) AS total
    FROM lancamentos WHERE cliente_id = ?`).get(hoje, hoje, clienteId);
  return {
    disponivel_centavos: r.disponivel,
    a_liberar_centavos: r.a_liberar,
    total_centavos: r.total,
  };
}

/** Quanto sai do saldo disponível em cada um dos próximos dias (agenda de recebíveis). */
function agenda(db, clienteId, hoje, dias = 30) {
  return db.prepare(`SELECT data_liberacao AS data, SUM(valor_centavos) AS valor_centavos, COUNT(*) AS lancamentos
    FROM lancamentos WHERE cliente_id = ? AND data_liberacao > ? AND data_liberacao <= date(?, '+' || ? || ' days')
    GROUP BY data_liberacao ORDER BY data_liberacao`).all(clienteId, hoje, hoje, dias);
}

/** Extrato com saldo acumulado, em ordem cronológica de competência. */
function extrato(db, clienteId, { de, ate, tipo = null, limite = 200, offset = 0 } = {}) {
  const cond = ['l.cliente_id = ?'];
  const p = [clienteId];
  if (de) { cond.push('l.data_competencia >= ?'); p.push(de); }
  if (ate) { cond.push('l.data_competencia <= ?'); p.push(ate); }
  if (tipo) { cond.push('l.tipo = ?'); p.push(tipo); }
  const onde = cond.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(valor_centavos), 0) AS soma FROM lancamentos l WHERE ${onde}`).get(...p);
  // Saldo que o cliente já tinha antes do primeiro lançamento da página.
  const anterior = de
    ? db.prepare('SELECT IFNULL(SUM(valor_centavos), 0) AS s FROM lancamentos WHERE cliente_id = ? AND data_competencia < ?').get(clienteId, de).s
    : 0;
  const itens = db.prepare(`SELECT l.*, b.nosso_numero, b.seu_numero, b.pagador_nome, b.valor_centavos AS boleto_valor_centavos,
      SUM(l.valor_centavos) OVER (ORDER BY l.data_competencia, l.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS acumulado
    FROM lancamentos l LEFT JOIN boletos b ON b.id = l.boleto_id
    WHERE ${onde} ORDER BY l.data_competencia, l.id LIMIT ? OFFSET ?`).all(...p, limite, offset);
  return {
    itens: itens.map((i) => ({ ...i, tipo_nome: TIPOS[i.tipo] ?? i.tipo, saldo_acumulado_centavos: anterior + i.acumulado })),
    total: total.n,
    soma_centavos: total.soma,
    saldo_anterior_centavos: anterior,
  };
}

/** Totais por tipo no período — base dos relatórios dos dois lados. */
function totaisPorTipo(db, clienteId, de, ate) {
  const linhas = db.prepare(`SELECT tipo, COUNT(*) AS quantidade, SUM(valor_centavos) AS valor_centavos
    FROM lancamentos WHERE cliente_id IS NOT NULL ${clienteId ? 'AND cliente_id = ?' : ''} AND data_competencia BETWEEN ? AND ?
    GROUP BY tipo`).all(...(clienteId ? [clienteId, de, ate] : [de, ate]));
  return linhas.map((l) => ({ ...l, tipo_nome: TIPOS[l.tipo] ?? l.tipo }));
}

/** Saldo de todos os clientes de uma vez (painel do backoffice). */
function saldosDosClientes(db, hoje) {
  return db.prepare(`SELECT c.id AS cliente_id, c.razao_social, c.nome_fantasia, c.situacao,
      IFNULL(SUM(CASE WHEN l.data_liberacao <= ? THEN l.valor_centavos ELSE 0 END), 0) AS disponivel_centavos,
      IFNULL(SUM(CASE WHEN l.data_liberacao  > ? THEN l.valor_centavos ELSE 0 END), 0) AS a_liberar_centavos
    FROM clientes c LEFT JOIN lancamentos l ON l.cliente_id = c.id
    GROUP BY c.id ORDER BY disponivel_centavos DESC`).all(hoje, hoje);
}

module.exports = { TIPOS, lancar, lancarLote, saldo, agenda, extrato, totaisPorTipo, saldosDosClientes };
