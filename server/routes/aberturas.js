'use strict';

const { Router } = require('express');
const { permitir } = require('../auth');
const abertura = require('../lib/abertura');

/** Análise das propostas de abertura de conta (equipe). Aprovar e recusar ficam com gerente e administrador. */
module.exports = (db) => {
  const r = Router();
  const decisores = permitir('admin', 'gerente');
  r.get('/', (req, res) => res.json(abertura.listar(db, { status: req.query.status })));
  r.get('/:id', (req, res) => res.json(abertura.detalhar(db, req.params.id)));
  r.post('/:id/aprovar', decisores, (req, res) => res.json(abertura.aprovar(db, req, req.params.id)));
  r.post('/:id/recusar', decisores, (req, res) => res.json(abertura.recusar(db, req, req.params.id, req.body?.motivo)));
  return r;
};
