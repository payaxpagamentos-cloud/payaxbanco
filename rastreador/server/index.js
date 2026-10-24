'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { iniciarGt06 } = require('./lib/gt06');
const { manutencao } = require('./lib/manutencao');

const db = abrir();
const extras = {};
if (config.portaGt06 > 0) {
  extras.gt06 = iniciarGt06(db, config.portaGt06);
  extras.gt06.servidor.on('listening', () => console.log(`[Rastreador] GT06 (TCP): porta ${config.portaGt06}`));
  extras.gt06.servidor.on('error', (err) => console.error(`[Rastreador] Servidor GT06 não iniciou na porta ${config.portaGt06}: ${err.message}`));
}
criarApp(db, extras).listen(config.port, () => {
  console.log(`[Rastreador] Painel: http://localhost:${config.port}${config.basePath}/`);
});

// Alerta de veículos sem comunicação e comandos expirados a cada minuto; limpeza das posições antigas uma vez por dia.
let ultimaLimpeza = 0;
setInterval(() => {
  try {
    const limpar = Date.now() - ultimaLimpeza > 24 * 3600_000;
    manutencao(db, { limpar });
    if (limpar) ultimaLimpeza = Date.now();
  } catch (err) {
    console.error('[Rastreador] Falha na manutenção:', err.message);
  }
}, 60_000).unref();
