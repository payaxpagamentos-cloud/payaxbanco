'use strict';

const { Router, raw } = require('express');
const config = require('../config');
const { registrar } = require('../lib/auditoria');
const docs = require('../lib/documentos');

/** Upload: corpo binário (application/octet-stream); nome, tipo e vínculo na query string. */
module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;

  r.get('/', (req, res) => res.json(docs.listar(db, eid(req), req.query)));
  r.post('/', raw({ type: () => true, limit: config.tamanhoMaximoArquivo }), (req, res) => {
    const id = docs.salvar(db, eid(req), req.body, req.query, { usuario_id: req.usuario.id });
    registrar(db, req, 'documento_enviado', { id, nome: req.query.nome, tipo: req.query.tipo, lancamento_id: req.query.lancamento_id }, eid(req));
    res.status(201).json({ id });
  });
  r.get('/:id/arquivo', (req, res) => docs.enviar(res, docs.buscar(db, eid(req), req.params.id)));
  r.delete('/:id', (req, res) => {
    const d = docs.excluir(db, eid(req), req.params.id);
    registrar(db, req, 'documento_excluido', { id: d.id, nome: d.nome }, eid(req));
    res.status(204).end();
  });
  return r;
};
