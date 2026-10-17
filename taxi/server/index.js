'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { expirarSolicitacoes } = require('./lib/corridas');

const db = abrir();
criarApp(db).listen(config.port, () => {
  const url = `http://localhost:${config.port}`;
  console.log(`[APP Táxi] Passageiro: ${url}/passageiro/  ·  Motorista: ${url}/motorista/  ·  Central: ${url}/central/`);
});

// Solicitações sem motorista expiram mesmo sem ninguém consultando.
setInterval(() => {
  try { expirarSolicitacoes(db); } catch (err) { console.error('[APP Táxi] Falha ao expirar solicitações:', err.message); }
}, 60_000).unref();
