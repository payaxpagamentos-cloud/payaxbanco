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
const http = criarApp(db, extras).listen(config.port, () => {
  console.log(`[Rastreador] Painel: http://localhost:${config.port}${config.basePath}/`);
});
http.on('error', (err) => {
  console.error(`[Rastreador] O painel não iniciou na porta ${config.port}: ${err.message}`);
  process.exit(1);
});
// Conexões paradas não seguram o processo na hora de reiniciar.
http.keepAliveTimeout = 65_000;
http.headersTimeout = 66_000;

// Tarefas de fundo a cada minuto (sem comunicação, sumiço, bloqueio programado, fila do WhatsApp, relatórios, comandos expirados);
// limpeza dos registros antigos uma vez por dia. Uma rodada que falhe não derruba as próximas.
let ultimaLimpeza = 0;
let rodandoManutencao = false;
function rodarManutencao() {
  if (rodandoManutencao) return;
  rodandoManutencao = true;
  try {
    const limpar = Date.now() - ultimaLimpeza > 24 * 3600_000;
    manutencao(db, { limpar });
    if (limpar) ultimaLimpeza = Date.now();
  } catch (err) {
    console.error('[Rastreador] Falha na manutenção:', err.message);
  } finally {
    rodandoManutencao = false;
  }
}
const timerManutencao = setInterval(rodarManutencao, 60_000);
timerManutencao.unref();
setTimeout(rodarManutencao, 15_000).unref();

// Um erro inesperado fora das rotas fica registrado em vez de derrubar o processo em silêncio. Erros síncronos não tratados
// param o processo de forma controlada (o PM2 ou o Docker reiniciam) para não continuar num estado incerto.
process.on('unhandledRejection', (motivo) => {
  console.error('[Rastreador] Promessa rejeitada sem tratamento:', motivo instanceof Error ? motivo.stack : motivo);
});
process.on('uncaughtException', (err) => {
  console.error('[Rastreador] Erro não tratado, reiniciando:', err.stack || err.message);
  encerrar(1);
});

// Encerramento controlado (pm2 stop/restart, docker stop): para de aceitar conexões, fecha o GT06 e o banco, e sai.
let encerrando = false;
function encerrar(codigo = 0) {
  if (encerrando) return;
  encerrando = true;
  clearInterval(timerManutencao);
  const forcado = setTimeout(() => process.exit(codigo), 8_000);
  forcado.unref();
  const fim = () => {
    try { db.close(); } catch { /* já fechado */ }
    process.exit(codigo);
  };
  Promise.resolve(extras.gt06 ? extras.gt06.fechar() : null)
    .catch(() => {})
    .then(() => new Promise((ok) => { http.close(() => ok()); http.closeAllConnections?.(); }))
    .then(fim, fim);
}
process.on('SIGTERM', () => encerrar(0));
process.on('SIGINT', () => encerrar(0));
