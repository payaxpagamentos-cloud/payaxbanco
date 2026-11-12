'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { expirarPendentes } = require('./lib/maquininha');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[Mercadinho] No ar em http://localhost:${config.port}${config.basePath}/`);
});

// Cobranças que ficaram pendentes na maquininha (cliente desistiu, maquininha desligou) são encerradas sozinhas.
setInterval(() => {
  try { expirarPendentes(db); } catch (err) { console.error('[Mercadinho] Falha ao expirar cobranças:', err.message); }
}, 60_000).unref();
