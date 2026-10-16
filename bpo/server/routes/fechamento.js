'use strict';

const { Router } = require('express');
const { registrar } = require('../lib/auditoria');
const fech = require('../lib/fechamento');
const { hoje, somarMeses } = require('../lib/datas');

module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;
  const mesAnterior = () => somarMeses(hoje(), -1).slice(0, 7);

  r.get('/', (req, res) => {
    const historico = db.prepare(`SELECT f.mes, f.concluido_em, u.nome AS usuario_nome FROM fechamentos f LEFT JOIN usuarios u ON u.id = f.usuario_id
      WHERE f.empresa_id = ? AND f.etapa = 'fechado' ORDER BY f.mes DESC LIMIT 24`).all(eid(req));
    res.json({ ...fech.situacao(db, eid(req), req.query.mes || mesAnterior()), historico });
  });
  r.post('/etapas', (req, res) => {
    fech.marcar(db, req, eid(req), req.body.mes, req.body.etapa, Boolean(req.body.concluir), req.body.observacao);
    registrar(db, req, 'fechamento_etapa', { mes: req.body.mes, etapa: req.body.etapa, concluir: Boolean(req.body.concluir), observacao: req.body.observacao }, eid(req));
    res.status(204).end();
  });
  r.post('/fechar', (req, res) => {
    fech.fechar(db, req, eid(req), req.body.mes);
    registrar(db, req, 'mes_fechado', { mes: req.body.mes }, eid(req));
    res.status(204).end();
  });
  r.post('/reabrir', (req, res) => {
    const n = fech.reabrir(db, req, eid(req), req.body.mes, req.body.motivo);
    registrar(db, req, 'mes_reaberto', { mes: req.body.mes, motivo: req.body.motivo, meses_reabertos: n }, eid(req));
    res.status(204).end();
  });
  return r;
};
