'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { manutencao } = require('./lib/chamadas');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[PABX] Painel: http://localhost:${config.port}${config.basePath}/`);
});

// Encerra chamadas presas e marca offline os ramais sem registro, mesmo sem ninguém no painel.
setInterval(() => {
  try { manutencao(db); } catch (err) { console.error('[PABX] Falha na manutenção:', err.message); }
}, 60_000).unref();
