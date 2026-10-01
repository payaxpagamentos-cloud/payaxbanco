'use strict';

/* Métricas do servidor (sistema, memória, disco, banco e backups). Só roda no Node. */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

function tamanho(arquivo) {
  try { return fs.statSync(arquivo).size; } catch { return null; }
}

function ultimoBackup() {
  const pasta = process.env.PAYAX_BACKUP_DIR || path.join(path.dirname(config.dbFile), 'backups');
  try {
    const arquivos = fs.readdirSync(pasta).filter((n) => n.endsWith('.db')).map((n) => fs.statSync(path.join(pasta, n)).mtime);
    return arquivos.length ? new Date(Math.max(...arquivos.map(Number))).toISOString() : null;
  } catch { return null; }
}

function coletar() {
  let disco = null;
  try {
    const s = fs.statfsSync(path.dirname(config.dbFile));
    disco = { total_bytes: s.blocks * s.bsize, livre_bytes: s.bavail * s.bsize };
  } catch { /* sistema de arquivos sem statfs */ }
  const mem = process.memoryUsage();
  return {
    ambiente: 'servidor',
    sistema: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    cpus: os.cpus().length,
    carga: os.loadavg().map((x) => Math.round(x * 100) / 100),
    memoria_total_bytes: os.totalmem(),
    memoria_livre_bytes: os.freemem(),
    processo_memoria_bytes: mem.rss,
    ativo_ha_s: Math.round(process.uptime()),
    servidor_ligado_ha_s: Math.round(os.uptime()),
    disco,
    banco_bytes: config.dbFile === ':memory:' ? null : tamanho(config.dbFile),
    banco_wal_bytes: config.dbFile === ':memory:' ? null : tamanho(`${config.dbFile}-wal`),
    ultimo_backup: ultimoBackup(),
  };
}

module.exports = { coletar };
