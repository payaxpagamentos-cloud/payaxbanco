'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');

const db = abrir();
const app = criarApp(db);

app.listen(config.port, () => {
  console.log(`[PAY AX] Banqueiro disponível em http://localhost:${config.port}`);
});
