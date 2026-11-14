'use strict';

/* Conformidade: as regras legais que o sistema segue, verificadas na hora (Backoffice). */
const express = require('express');
const { naoEncontrado } = require('../lib/erros');
const { exigir } = require('../auth');
const conformidade = require('../lib/conformidade');
const auditoria = require('../lib/auditoria');

module.exports = (db) => {
  const r = express.Router();

  r.get('/', exigir('conformidade.ver', '*'), async (_req, res) => {
    res.json(await conformidade.verificar(db));
  });

  /** Situação de uma regra de acompanhamento (Bradesco, jurídico, provedor). */
  r.put('/:regra', exigir('conformidade.editar', '*'), async (req, res) => {
    const out = conformidade.registrar(db, req.params.regra, req.body ?? {}, req.usuario);
    if (!out) throw naoEncontrado('Regra');
    auditoria.registrar(db, req, { acao: 'conformidade.atualizada', entidade: 'conformidade', antes: out.antes,
      depois: { regra: req.params.regra, ...out.depois } });
    const tudo = await conformidade.verificar(db);
    res.json(tudo.grupos.flatMap((g) => g.regras).find((x) => x.id === req.params.regra));
  });

  return r;
};
