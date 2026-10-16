'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[PAY AX BPO] BPO Financeiro disponível em http://localhost:${config.port}`);
});
