'use strict';

const { Router } = require('express');
const config = require('../config');
const v = require('../lib/validacao');
const { paginacao } = require('../lib/paginacao');

function filtrar(query) {
  const F = config.fusoSqlite;
  const filtros = [];
  const params = [];
  if (query.tipo) { filtros.push('t.tipo = ?'); params.push(query.tipo); }
  if (query.conta_id) { filtros.push('t.conta_id = ?'); params.push(query.conta_id); }
  if (query.inicio) { v.exigir(v.dataValida(query.inicio), 'Data inicial inválida.'); filtros.push('date(t.criado_em, ?) >= ?'); params.push(F, query.inicio); }
  if (query.fim) { v.exigir(v.dataValida(query.fim), 'Data final inválida.'); filtros.push('date(t.criado_em, ?) <= ?'); params.push(F, query.fim); }
  if (query.q) {
    filtros.push("(cl.nome LIKE ? OR c.numero LIKE ? OR t.descricao LIKE ?)");
    params.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`);
  }
  return { where: filtros.length ? `WHERE ${filtros.join(' AND ')}` : '', params };
}

const SELECT = `SELECT t.*, c.agencia, c.numero || '-' || c.digito AS conta, cl.nome AS cliente_nome, u.nome AS usuario_nome
  FROM transacoes t JOIN contas c ON c.id = t.conta_id JOIN clientes cl ON cl.id = c.cliente_id
  LEFT JOIN usuarios u ON u.id = t.usuario_id`;

module.exports = (db) => {
  const r = Router();
  r.get('/', (req, res) => {
    const { limite, offset, pagina } = paginacao(req.query);
    const { where, params } = filtrar(req.query);
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM transacoes t JOIN contas c ON c.id = t.conta_id
      JOIN clientes cl ON cl.id = c.cliente_id ${where}`).get(...params);
    const itens = db.prepare(`${SELECT} ${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
    res.json({ itens, total, pagina, limite });
  });
  return r;
};

module.exports.filtrar = filtrar;
module.exports.SELECT = SELECT;
