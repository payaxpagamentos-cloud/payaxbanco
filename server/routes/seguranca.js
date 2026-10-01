'use strict';

const { Router } = require('express');
const seguranca = require('../lib/seguranca');
const { transacao } = require('../db');
const v = require('../lib/validacao');

/** Monitoramento de segurança (somente administrador). */
module.exports = (db) => {
  const r = Router();

  r.get('/', (_req, res) => res.json(seguranca.painel(db)));

  r.get('/verificacoes/:id', (req, res) => res.json(seguranca.detalhar(db, req.params.id)));

  r.post('/verificar', (req, res) => res.json(transacao(db, () => seguranca.executar(db, { origem: 'manual', usuarioId: req.usuario.id }))));

  /** Aprova as alterações de código atuais como a nova versão oficial (linha de base). */
  r.post('/integridade/aprovar', (req, res) => {
    const motivo = v.texto(req.body?.motivo, 500);
    v.exigir(motivo && motivo.length >= 5, 'Informe o motivo (ex.: atualização da versão 1.15).');
    const arquivos = transacao(db, () => seguranca.aprovarIntegridade(db, req, motivo));
    res.json({ arquivos, verificacao: transacao(db, () => seguranca.executar(db, { origem: 'aprovacao', usuarioId: req.usuario.id })) });
  });

  return r;
};
