'use strict';

const { Router } = require('express');
const { registrar } = require('../lib/auditoria');
const orc = require('../lib/orcamento');
const { hoje } = require('../lib/datas');

module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;
  r.get('/', (req, res) => res.json(orc.comparativo(db, eid(req), req.query.ano || hoje().slice(0, 4))));
  r.put('/', (req, res) => {
    orc.salvar(db, eid(req), req.body.itens);
    registrar(db, req, 'orcamento_alterado', { itens: req.body.itens?.length }, eid(req));
    res.status(204).end();
  });
  r.post('/sugerir', (req, res) => {
    const x = orc.sugerir(db, eid(req), String(req.body.ano), req.body.reajuste);
    registrar(db, req, 'orcamento_sugerido', { ano: req.body.ano, reajuste: req.body.reajuste }, eid(req));
    res.json(x);
  });
  return r;
};
