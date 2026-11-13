'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { manutencao } = require('./lib/manutencao');
const { processarFila } = require('./lib/envio');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[ZOE Atende] Painel: http://localhost:${config.port}${config.basePath}/`);
  if (!config.ia.chave) console.log('[ZOE Atende] Sem ATEND_IA_CHAVE: a ZOE roda só com as intenções e a base de conhecimento.');
});

// A fila de saída também gira sozinha: uma mensagem que falhou volta a ser tentada mesmo sem ninguém no painel.
setInterval(() => { processarFila(db).catch((err) => console.error('[ZOE Atende] Falha na fila de envio:', err.message)); }, 20_000).unref();

// Encerra conversas abandonadas, cobra o CSAT e limpa os registros antigos.
setInterval(() => {
  manutencao(db).catch((err) => console.error('[ZOE Atende] Falha na manutenção:', err.message));
}, 60_000).unref();
