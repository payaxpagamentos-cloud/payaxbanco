'use strict';

const config = require('./config');
const { abrir, lerConfig } = require('./db');
const { criarApp } = require('./app');
const { processarFila } = require('./lib/baixas');
const { expirarVencidas } = require('./lib/maquininha');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[Payax PDV] PDV: http://localhost:${config.port}${config.basePath}/`);
});

// Fila do IXC e limpeza das cobranças no cartão sem resposta: o PDV continua recebendo mesmo com o IXC fora do ar,
// e estas rodadas colocam as baixas em dia assim que ele volta.
const intervalo = Math.max(10, lerConfig(db).fila_intervalo_s) * 1000;
let rodando = false;
setInterval(async () => {
  if (rodando) return;
  rodando = true;
  try {
    expirarVencidas(db);
    await processarFila(db);
  } catch (err) {
    console.error('[Payax PDV] Falha na fila de baixas:', err.message);
  } finally {
    rodando = false;
  }
}, intervalo).unref();
