'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { iniciarColetas, iniciarCobranca, iniciarProvisionamento, iniciarSessoes } = require('./coletas');

const db = abrir();
criarApp(db).listen(config.port, () => console.log(`[Network] Painel: http://localhost:${config.port}${config.basePath}/`));
if (config.coletasAutomaticas) {
  iniciarColetas(db);
  iniciarCobranca(db);
}
if (config.provisionamentoAutomatico) {
  iniciarProvisionamento(db);
  // A varredura de sessões é o que mantém o mapa do Panorama dizendo a verdade sobre quem está no ar.
  iniciarSessoes(db);
}
