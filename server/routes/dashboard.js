'use strict';

const { Router } = require('express');
const config = require('../config');

module.exports = (db) => {
  const r = Router();
  const F = config.fusoSqlite;

  r.get('/', (_req, res) => {
    const um = (sql, ...p) => db.prepare(sql).get(...p);
    const clientes = um(`SELECT COUNT(*) AS total,
        SUM(status = 'ativo') AS ativos, SUM(tipo = 'PF') AS pf, SUM(tipo = 'PJ') AS pj FROM clientes`);
    const contas = um(`SELECT COUNT(*) AS total, SUM(status = 'ativa') AS ativas, SUM(status = 'bloqueada') AS bloqueadas,
        COALESCE(SUM(CASE WHEN status <> 'encerrada' THEN saldo_centavos END),0) AS saldo_total_centavos,
        COALESCE(SUM(CASE WHEN saldo_centavos < 0 THEN saldo_centavos END),0) AS saldo_negativo_centavos,
        COALESCE(SUM(CASE WHEN status = 'ativa' THEN limite_centavos END),0) AS limite_concedido_centavos FROM contas`);
    const hoje = um(`SELECT COUNT(*) AS transacoes,
        COALESCE(SUM(CASE WHEN valor_centavos > 0 THEN valor_centavos END),0) AS entradas_centavos,
        COALESCE(-SUM(CASE WHEN valor_centavos < 0 THEN valor_centavos END),0) AS saidas_centavos
      FROM transacoes WHERE date(criado_em, ?) = date('now', ?)`, F, F);
    const carteira = um(`SELECT COUNT(DISTINCT e.id) AS ativos, COALESCE(SUM(p.valor_centavos),0) AS saldo_devedor_centavos,
        COALESCE(SUM(CASE WHEN p.vencimento < date('now', ?) THEN p.valor_centavos END),0) AS vencido_centavos
      FROM emprestimos e JOIN parcelas p ON p.emprestimo_id = e.id AND p.status = 'aberta' WHERE e.status = 'ativo'`, F);
    const serie = db.prepare(`WITH RECURSIVE dias(d) AS (SELECT date('now', ?, '-13 days') UNION ALL SELECT date(d, '+1 day') FROM dias WHERE d < date('now', ?))
      SELECT d AS dia,
        COALESCE((SELECT SUM(valor_centavos) FROM transacoes WHERE date(criado_em, ?) = d AND valor_centavos > 0),0) AS entradas_centavos,
        COALESCE((SELECT -SUM(valor_centavos) FROM transacoes WHERE date(criado_em, ?) = d AND valor_centavos < 0),0) AS saidas_centavos
      FROM dias`).all(F, F, F, F);
    const porTipo = db.prepare(`SELECT tipo, COUNT(*) AS quantidade, COALESCE(SUM(saldo_centavos),0) AS saldo_centavos
      FROM contas WHERE status <> 'encerrada' GROUP BY tipo ORDER BY saldo_centavos DESC`).all();
    const ultimas = db.prepare(`SELECT t.id, t.tipo, t.valor_centavos, t.descricao, t.criado_em, t.conta_id,
        c.numero || '-' || c.digito AS conta, cl.nome AS cliente_nome
      FROM transacoes t JOIN contas c ON c.id = t.conta_id JOIN clientes cl ON cl.id = c.cliente_id
      ORDER BY t.id DESC LIMIT 8`).all();
    const maiores = db.prepare(`SELECT cl.id, cl.nome, cl.tipo, COALESCE(SUM(c.saldo_centavos),0) AS saldo_centavos
      FROM clientes cl JOIN contas c ON c.cliente_id = cl.id AND c.status <> 'encerrada'
      GROUP BY cl.id ORDER BY saldo_centavos DESC LIMIT 5`).all();
    res.json({ clientes, contas, hoje, carteira, serie, porTipo, ultimas, maiores });
  });

  return r;
};
