'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const backup = require('./lib/backup');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[Ativa BPO] Sistema da equipe em http://localhost:${config.port}${config.basePath}/`);
  console.log(`[Ativa BPO] Portal do Cliente em http://localhost:${config.port}${config.portalPath}/`);
});

// Backup automático do banco (padrão: a cada 24 h, mantendo os 30 mais recentes).
const fazerBackup = () => {
  try {
    const b = backup.gerar(db);
    console.log(`[Ativa BPO] Backup gerado: ${b.nome}`);
  } catch (err) {
    console.error('[Ativa BPO] Falha no backup:', err.message);
  }
};
setInterval(fazerBackup, config.backupIntervaloHoras * 3_600_000).unref();
if (!backup.listar().length) fazerBackup();
