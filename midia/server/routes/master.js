'use strict';

const { Router } = require('express');

/** Painel da equipe (master e operador): cadastros, campanhas, criativos, relatórios, faturamento e administração. */
module.exports = (db) => {
  const r = Router();
  r.use(require('./cadastros')(db));
  r.use(require('./campanhas')(db));
  r.use(require('./financeiro')(db));
  r.use(require('./gestao')(db));
  return r;
};
