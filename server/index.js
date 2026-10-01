'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const seguranca = require('./lib/seguranca');
const { fonteDisco } = require('./lib/integridade-fs');
const monitorServidor = require('./lib/monitor-servidor');

const db = abrir();
const app = criarApp(db);

// Monitoramento de segurança: verifica ao iniciar e depois de hora em hora (PAYAX_SEGURANCA_INTERVALO_MIN).
seguranca.configurar({ fonte: fonteDisco(), coletarServidor: monitorServidor.coletar });

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
