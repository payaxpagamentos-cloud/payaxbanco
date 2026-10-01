'use strict';

const { Router } = require('express');
const { paginacao } = require('../lib/paginacao');

module.exports = (db) => {
  const r = Router();
  r.get('/', (req, res) => {
    const { limite, offset, pagina } = paginacao(req.query);
    const filtros = [];
    const params = [];
    if (req.query.entidade) { filtros.push('a.entidade = ?'); params.push(req.query.entidade); }
    if (req.query.usuario_id) { filtros.push('a.usuario_id = ?'); params.push(req.query.usuario_id); }
    if (req.query.q) { filtros.push('(a.acao LIKE ? OR a.detalhes LIKE ? OR u.nome LIKE ?)'); params.push(...Array(3).fill(`%${req.query.q}%`)); }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const base = `FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id ${where}`;
    const { total } = db.prepare(`SELECT COUNT(*) AS total ${base}`).get(...params);
    const itens = db.prepare(`SELECT a.*, u.nome AS usuario_nome ${base} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
    res.json({ itens, total, pagina, limite });
  });
  return r;
};
