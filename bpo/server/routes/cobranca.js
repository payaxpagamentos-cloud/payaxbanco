'use strict';

const { Router } = require('express');
const { registrar } = require('../lib/auditoria');
const cob = require('../lib/cobranca');
const v = require('../lib/validacao');

module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;

  r.get('/', (req, res) => res.json(cob.painel(db, eid(req))));
  r.get('/lembretes', (req, res) => res.json(cob.lembretes(db, req.empresa, Math.min(30, Math.max(0, Number(req.query.dias ?? 3))))));
  r.get('/clientes/:id', (req, res) => res.json(cob.ficha(db, eid(req), req.params.id)));

  r.post('/registros', (req, res) => {
    const id = cob.registrarContato(db, req, eid(req), req.body);
    registrar(db, req, 'cobranca_registrada', { id, canal: req.body.canal, contato_id: req.body.contato_id }, eid(req));
    res.status(201).json({ id });
  });
  r.post('/promessas', (req, res) => {
    const id = cob.registrarPromessa(db, req, eid(req), req.body);
    registrar(db, req, 'promessa_registrada', { id, contato_id: req.body.contato_id, valor_centavos: req.body.valor_centavos }, eid(req));
    res.status(201).json({ id });
  });
  r.post('/promessas/:id/resolver', (req, res) => {
    cob.resolverPromessa(db, eid(req), req.params.id, req.body.status);
    registrar(db, req, 'promessa_resolvida', { id: Number(req.params.id), status: req.body.status }, eid(req));
    res.status(204).end();
  });
  r.post('/acordos', (req, res) => {
    const a = cob.acordo(db, req, eid(req), req.body);
    registrar(db, req, 'acordo_criado', a, eid(req));
    res.status(201).json(a);
  });
  r.patch('/config', (req, res) => {
    db.prepare('UPDATE empresas SET chave_pix_cobranca = ? WHERE id = ?').run(v.texto(req.body.chave_pix_cobranca, 120), eid(req));
    res.status(204).end();
  });
  return r;
};
