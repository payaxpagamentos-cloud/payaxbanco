'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { iniciarColetas } = require('./coletas');

const db = abrir();
criarApp(db).listen(config.port, () => console.log(`[Network] Painel: http://localhost:${config.port}${config.basePath}/`));
if (config.coletasAutomaticas) iniciarColetas(db);
