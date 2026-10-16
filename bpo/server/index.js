'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const backup = require('./lib/backup');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[PAY AX BPO] BPO Financeiro disponível em http://localhost:${config.port}`);
  console.log(`[PAY AX BPO] Portal do Cliente em http://localhost:${config.port}/portal/`);
});

// Backup automático do banco (padrão: a cada 24 h, mantendo os 30 mais recentes).
const fazerBackup = () => {
  try {
    const b = backup.gerar(db);
    console.log(`[PAY AX BPO] Backup gerado: ${b.nome}`);
  } catch (err) {
    console.error('[PAY AX BPO] Falha no backup:', err.message);
  }
};
setInterval(fazerBackup, config.backupIntervaloHoras * 3_600_000).unref();
if (!backup.listar().length) fazerBackup();
