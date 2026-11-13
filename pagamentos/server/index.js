'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const rotinas = require('./lib/rotinas');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[PayAx] Backoffice em http://localhost:${config.port}${config.basePath}/`);
  console.log(`[PayAx] Internet Bank do cliente em http://localhost:${config.port}${config.clientePath}/`);
  console.log(`[PayAx] Banco: modo ${config.banco.modo} (${config.banco.ambiente}).`);
});

if (config.rotinas) rotinas.agendar(db);
