'use strict';

const { Router } = require('express');
const alcadas = require('../lib/alcadas');
const { transacao } = require('../db');
const { registrar } = require('../lib/auditoria');

/** Alçadas de gerente e operador (somente administrador). */
module.exports = (db) => {
  const r = Router();

  r.get('/', (_req, res) => res.json({ perfis: alcadas.PERFIS_CONFIGURAVEIS, permissoes: alcadas.listar(db) }));

  r.put('/', (req, res) => {
    const mudancas = transacao(db, () => {
      const m = alcadas.salvar(db, req.usuario.id, req.body);
      if (m.length) registrar(db, req, 'alterar_alcadas', 'alcada', null, { mudancas: m });
      return m;
    });
    res.json({ alteradas: mudancas.length, permissoes: alcadas.listar(db) });
  });

  r.post('/restaurar-padrao', (req, res) => {
    transacao(db, () => {
      alcadas.restaurar(db);
      registrar(db, req, 'restaurar_alcadas', 'alcada', null);
    });
    res.json({ permissoes: alcadas.listar(db) });
  });

  return r;
};
