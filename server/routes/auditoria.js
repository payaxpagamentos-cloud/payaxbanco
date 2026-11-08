'use strict';

const { Router } = require('express');

module.exports = (db) => {
  const r = Router();
  r.get('/', (req, res) => {
    const filtros = ['1 = 1'];
    const params = [];
    if (req.query.empresa_id) { filtros.push('a.empresa_id = ?'); params.push(Number(req.query.empresa_id)); }
    if (req.query.acao) { filtros.push('a.acao LIKE ?'); params.push(`%${req.query.acao}%`); }
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const limite = 50;
    const where = filtros.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM auditoria a WHERE ${where}`).get(...params).n;
    const itens = db.prepare(`SELECT a.*, u.nome AS usuario_nome, e.razao_social AS empresa_nome FROM auditoria a
      LEFT JOIN usuarios u ON u.id = a.usuario_id LEFT JOIN empresas e ON e.id = a.empresa_id
      WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, limite, (pagina - 1) * limite);
    res.json({ itens, total, pagina, limite });
  });
  return r;
};
