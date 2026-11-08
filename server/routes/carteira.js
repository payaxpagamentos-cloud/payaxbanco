'use strict';

const { Router } = require('express');
const { filtroCarteira } = require('../lib/acesso');
const fech = require('../lib/fechamento');
const { hoje, somarMeses } = require('../lib/datas');

/** Acompanhamento do fechamento mensal de toda a carteira visível ao usuário. */
module.exports = (db) => {
  const r = Router();
  r.get('/fechamento', (req, res) => {
    const mes = req.query.mes || somarMeses(hoje(), -1).slice(0, 7);
    const f = filtroCarteira(req.usuario);
    const empresas = db.prepare(`SELECT e.*, u.nome AS analista_nome FROM empresas e LEFT JOIN usuarios u ON u.id = e.analista_id
      WHERE ${f.sql} AND e.status IN ('ativa','implantacao') ORDER BY COALESCE(e.nome_fantasia, e.razao_social)`).all(...f.params);
    res.json({ mes, etapas: fech.ETAPAS, empresas: fech.carteira(db, empresas, mes) });
  });
  return r;
};
