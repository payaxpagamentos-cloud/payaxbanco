'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const rotinas = require('./lib/rotinas');
const backup = require('./lib/backup');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[PAY AX] Backoffice em http://localhost:${config.port}${config.basePath}/`);
  console.log(`[PAY AX] Área do Cliente do cliente em http://localhost:${config.port}${config.clientePath}/`);
  console.log(`[PAY AX] Banco: modo ${config.banco.modo} (${config.banco.ambiente}).`);
});

if (config.banco.modo === 'cnab') {
  // As pastas precisam existir antes do primeiro arquivo: é para elas que o agente do banco aponta.
  for (const p of [config.cnab.pastaRemessa, config.cnab.pastaRetorno, config.cnab.pastaProcessados]) {
    require('node:fs').mkdirSync(p, { recursive: true });
  }
  console.log(`[PAY AX] CNAB 400 — remessa em ${config.cnab.pastaRemessa}, retorno em ${config.cnab.pastaRetorno}.`);
}

if (config.rotinas) rotinas.agendar(db);

// Backup automático do banco: a conta gráfica é o livro-razão do dinheiro dos clientes.
if (config.backupAutomatico) {
  const fazer = () => {
    try {
      const b = backup.gerar(db, { automatico: true });
      if (b.confere) console.log(`[PAY AX] Backup gerado e conferido: ${b.nome} (${b.lancamentos} lançamentos).`);
      else console.error(`[PAY AX] ATENÇÃO — backup ${b.nome} NÃO conferiu: ${b.divergencia}`);
    } catch (err) {
      console.error('[PAY AX] Falha ao gerar backup:', err.message);
    }
  };
  setInterval(fazer, config.backupIntervaloHoras * 3_600_000).unref();
  if (!backup.arquivos().length) fazer();
}
