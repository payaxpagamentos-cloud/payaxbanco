'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const seguranca = require('./lib/seguranca');
const { fonteDisco } = require('./lib/integridade-fs');
const monitorServidor = require('./lib/monitor-servidor');
const { gerarBackup } = require('./lib/backup');
const path = require('node:path');

const db = abrir();
const app = criarApp(db);

// Monitoramento de segurança: verifica ao iniciar e depois de hora em hora (PAYAX_SEGURANCA_INTERVALO_MIN).
// O monitoramento dos serviços (página de status) roda a cada PAYAX_MONITOR_INTERVALO_MIN minutos (padrão 5).
seguranca.configurar({
  fonte: fonteDisco(undefined, path.join(path.dirname(config.dbFile), 'quarentena')),
  coletarServidor: monitorServidor.coletar,
  fazerBackup: gerarBackup,
});

app.listen(config.port, () => {
  console.log(`[PAY AX] Banqueiro disponível em http://localhost:${config.port}`);
  try {
    const v = seguranca.executar(db, { origem: 'inicial' });
    console.log(`[PAY AX] Verificação de segurança: ${v.status} (integridade: ${v.integridade.status}).`);
  } catch (err) {
    console.error('[PAY AX] Verificação de segurança falhou:', err.message);
  }
  seguranca.agendar(db);
});
