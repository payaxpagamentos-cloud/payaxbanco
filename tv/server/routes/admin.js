'use strict';

const { Router } = require('express');

/** Painel da operação: conteúdo (canais, grade, catálogo) e negócio (planos, assinantes, faturas). */
module.exports = (db) => {
  const r = Router();
  r.use(require('./admin-conteudo')(db));
  r.use(require('./admin-negocio')(db));
  return r;
};
