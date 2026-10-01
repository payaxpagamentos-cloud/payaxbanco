'use strict';

const { Router } = require('express');
const antifraude = require('../lib/antifraude');
const { transacao } = require('../db');

/** Antifraude: equipe de antifraude e administrador (alçada "antifraude.analisar"). */
module.exports = (db) => {
  const r = Router();
  // Cada consulta começa analisando o que entrou desde a última vez.
  const atualizar = () => transacao(db, () => antifraude.analisar(db));

  r.get('/painel', (req, res) => { atualizar(); res.json(antifraude.painel(db, req.query.dias)); });

  r.get('/alertas', (req, res) => {
    atualizar();
    res.json(antifraude.listarAlertas(db, { status: req.query.status || undefined, severidade: req.query.severidade || undefined }));
  });

  r.get('/pendentes', (_req, res) => {
    atualizar();
    res.json({ total: db.prepare("SELECT COUNT(*) AS n FROM alertas_fraude WHERE status = 'aberto'").get().n });
  });

  r.get('/alertas/:id', (req, res) => res.json(antifraude.detalharAlerta(db, req.params.id)));

  r.post('/alertas/:id/decidir', (req, res) => res.json(transacao(db, () => antifraude.decidir(db, req, req.params.id, {
    acao: req.body?.acao, parecer: req.body?.parecer, bloquearIb: Boolean(req.body?.bloquear_ib), bloquearConta: Boolean(req.body?.bloquear_conta),
  }))));

  return r;
};
