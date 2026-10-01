'use strict';

const { Router } = require('express');
const alcadas = require('../lib/alcadas');
const ouvidoria = require('../lib/ouvidoria');
const { transacao } = require('../db');
const { registrar } = require('../lib/auditoria');

/** Alçadas de gerente, operador e ouvidoria, e as ações que exigem análise da Ouvidoria (somente administrador). */
module.exports = (db) => {
  const r = Router();

  const tudo = () => ({ perfis: alcadas.PERFIS_CONFIGURAVEIS, permissoes: alcadas.listar(db), analises: ouvidoria.listarRegras(db) });

  r.get('/', (_req, res) => res.json(tudo()));

  r.put('/', (req, res) => {
    const mudancas = transacao(db, () => {
      const { analises, ...perfis } = req.body ?? {};
      const m = [...alcadas.salvar(db, req.usuario.id, perfis), ...ouvidoria.salvarRegras(db, req.usuario.id, analises)];
      if (m.length) registrar(db, req, 'alterar_alcadas', 'alcada', null, { mudancas: m });
      return m;
    });
    res.json({ alteradas: mudancas.length, ...tudo() });
  });

  r.post('/restaurar-padrao', (req, res) => {
    transacao(db, () => {
      alcadas.restaurar(db);
      ouvidoria.restaurarRegras(db);
      registrar(db, req, 'restaurar_alcadas', 'alcada', null);
    });
    res.json(tudo());
  });

  return r;
};
