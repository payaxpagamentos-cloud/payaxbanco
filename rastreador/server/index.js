'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { iniciarGt06 } = require('./lib/gt06');
const { manutencao } = require('./lib/manutencao');

// Licença de uso presa a este servidor: em produção, sem licença válida o sistema não sobe (proteção de cópia).
require('./lib/licenca').exigir();

const db = abrir();
const extras = {};
// Rastreadores GT06: quem atende a porta é o serviço separado (rastreador-gt06), que não cai quando o painel reinicia numa
// atualização. O painel só atende a porta enquanto o serviço não estiver no ar, e devolve assim que ele voltar.
const servicoGt06 = require('./lib/servicoGt06');
const SEM_SERVICO_MS = 30_000;
// Comando novo: com o serviço separado, avisa ele na hora (ele entrega em milissegundos).
require('./lib/comandos').canal.on('comando', ({ protocolo }) => { if (protocolo === 'gt06' && extras.gt06?.separado) servicoGt06.avisarComando(); });
function usarServico() {
  const proprio = extras.gt06 && !extras.gt06.separado ? extras.gt06 : null;
  extras.gt06 = servicoGt06.ponte();
  if (proprio) {
    Promise.resolve(proprio.fechar()).catch(() => {});
    console.log('[Rastreador] GT06: serviço separado no ar; o painel devolveu a porta a ele.');
  } else {
    console.log('[Rastreador] GT06: rastreadores atendidos pelo serviço separado (rastreador-gt06).');
  }
}
function usarProprio(motivo) {
  const g = iniciarGt06(db, config.portaGt06);
  extras.gt06 = g;
  g.servidor.on('listening', () => console.log(`[Rastreador] GT06 (TCP): porta ${config.portaGt06}, atendida pelo painel (${motivo}).`));
  g.servidor.on('error', (err) => {
    console.error(`[Rastreador] Servidor GT06 não iniciou na porta ${config.portaGt06}: ${err.message}`);
    // Outro processo está com a porta: volta a esperar o serviço separado.
    if (extras.gt06 === g) extras.gt06 = servicoGt06.ponte();
    g.fechar().catch(() => {});
  });
}
if (config.portaGt06 > 0) {
  if (servicoGt06.ativo()) usarServico();
  else usarProprio('o serviço separado não estava no ar');
  let semServicoDesde = null;
  setInterval(() => {
    const ativo = servicoGt06.ativo();
    if (!extras.gt06.separado) { if (ativo) usarServico(); return; }
    if (ativo) { semServicoDesde = null; return; }
    semServicoDesde ??= Date.now();
    // O serviço sumiu (parado ou travado) por mais de 30 s: o painel atende, para nenhum rastreador ficar sem servidor.
    if (Date.now() - semServicoDesde > SEM_SERVICO_MS) { semServicoDesde = null; usarProprio('o serviço separado parou'); }
  }, 5000).unref();
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
// Se o processo que nos iniciou (PM2) sumir, ficamos órfãos segurando as portas: encerra para o PM2 subir um novo.
// Só vale no PM2: iniciado à mão (nohup, script de deploy), o processo pai some de propósito e o painel deve continuar.
const paiInicial = process.ppid;
if (process.env.pm_id !== undefined) setInterval(() => {
  if (process.ppid !== paiInicial && !encerrando) {
    console.error('[Rastreador] Ficou sem o processo que o iniciou; encerrando.');
    encerrar(0);
  }
}, 5000).unref();
process.on('SIGTERM', () => encerrar(0));
process.on('SIGINT', () => encerrar(0));
