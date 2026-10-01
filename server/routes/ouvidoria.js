'use strict';

const { Router } = require('express');
const ouvidoria = require('../lib/ouvidoria');
const { transacao } = require('../db');

/** Fila da Ouvidoria: toda a equipe acompanha; quem tem a alçada "Analisar solicitações" decide. */
module.exports = (db) => {
  const r = Router();

  r.get('/', (req, res) => res.json(ouvidoria.listar(db, {
    status: req.query.status || undefined, conta_id: req.query.conta_id || undefined, cliente_id: req.query.cliente_id || undefined,
  })));

  r.get('/pendentes', (_req, res) => res.json({ total: db.prepare("SELECT COUNT(*) AS n FROM solicitacoes WHERE status = 'em_analise'").get().n }));

  r.get('/:id', (req, res) => res.json(ouvidoria.detalhar(db, req.params.id)));

  r.post('/:id/aprovar', (req, res) => res.json(transacao(db, () => ouvidoria.decidir(db, req, req.params.id, { aprovar: true, parecer: req.body?.parecer }))));

  r.post('/:id/recusar', (req, res) => res.json(transacao(db, () => ouvidoria.decidir(db, req, req.params.id, { aprovar: false, parecer: req.body?.parecer }))));

  r.post('/:id/cancelar', (req, res) => res.json(transacao(db, () => ouvidoria.cancelar(db, req, req.params.id))));

  return r;
};
