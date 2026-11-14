'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Ligação entre o painel e o serviço GT06 separado (processo próprio, que mantém os rastreadores conectados mesmo quando o
 * painel reinicia numa atualização). Os dois conversam por um arquivo de situação ao lado do banco.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

const PASTA = path.dirname(config.dbFile);
const SITUACAO = path.join(PASTA, 'gt06-servico.json');
const REINICIAR = path.join(PASTA, 'gt06-reiniciar');
// O painel grava aqui quando cria um comando: o serviço vê na hora (sem esperar a próxima conferência do banco).
const AVISO_COMANDO = 'gt06-comando';
const VIVO_MS = 15_000;

function ler() {
  try {
    const s = JSON.parse(fs.readFileSync(SITUACAO, 'utf8'));
    return Date.now() - Date.parse(s.em) <= VIVO_MS ? s : null;
  } catch {
    return null;
  }
}
const ativo = () => Boolean(ler());

function gravar(dados) {
  const tmp = `${SITUACAO}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...dados, pid: process.pid, em: new Date().toISOString() }));
  fs.renameSync(tmp, SITUACAO);
}

/** Para o painel: o mesmo formato do servidor GT06 interno, lendo a situação do serviço separado. */
function ponte() {
  return {
    separado: true,
    conectados: () => ler()?.imeis?.length ?? 0,
    conectado: (imei) => Boolean(ler()?.imeis?.includes(imei)),
    fechar: async () => {},
  };
}

/** Impressão digital do código que o serviço carregou: se mudar numa atualização, ele precisa reiniciar. */
function digital(arquivos) {
  const h = crypto.createHash('sha256');
  for (const a of [...arquivos].sort()) {
    try { h.update(a).update(fs.readFileSync(a)); } catch { h.update(`${a}:ausente`); }
  }
  return h.digest('hex');
}
const pedirReinicio = () => fs.writeFileSync(REINICIAR, new Date().toISOString());
const avisarComando = () => { try { fs.writeFileSync(path.join(PASTA, AVISO_COMANDO), String(Date.now())); } catch { /* o serviço confere o banco de qualquer jeito */ } };
/** No serviço: chama `fn` assim que o painel avisar de um comando novo. Devolve a função que para de vigiar. */
function aoAvisoDeComando(fn) {
  try {
    const w = fs.watch(PASTA, (_ev, nome) => { if (nome === AVISO_COMANDO) fn(); });
    w.on('error', () => {});
    return () => w.close();
  } catch {
    return () => {};
  }
}

module.exports = { ler, ativo, gravar, ponte, digital, pedirReinicio, avisarComando, aoAvisoDeComando, SITUACAO, REINICIAR };
