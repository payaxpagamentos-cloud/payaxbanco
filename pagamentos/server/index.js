'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const rotinas = require('./lib/rotinas');
const backup = require('./lib/backup');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[PayAx] Backoffice em http://localhost:${config.port}${config.basePath}/`);
  console.log(`[PayAx] Internet Bank do cliente em http://localhost:${config.port}${config.clientePath}/`);
  console.log(`[PayAx] Banco: modo ${config.banco.modo} (${config.banco.ambiente}).`);
});

if (config.rotinas) rotinas.agendar(db);

// Backup automático do banco: a conta gráfica é o livro-razão do dinheiro dos clientes.
if (config.backupAutomatico) {
  const fazer = () => {
    try {
      const b = backup.gerar(db, { automatico: true });
      if (b.confere) console.log(`[PayAx] Backup gerado e conferido: ${b.nome} (${b.lancamentos} lançamentos).`);
      else console.error(`[PayAx] ATENÇÃO — backup ${b.nome} NÃO conferiu: ${b.divergencia}`);
    } catch (err) {
      console.error('[PayAx] Falha ao gerar backup:', err.message);
    }
  };
  setInterval(fazer, config.backupIntervaloHoras * 3_600_000).unref();
  if (!backup.arquivos().length) fazer();
}
