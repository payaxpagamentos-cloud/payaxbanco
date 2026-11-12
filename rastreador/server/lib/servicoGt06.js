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

module.exports = { ler, ativo, gravar, ponte, digital, pedirReinicio, SITUACAO, REINICIAR };
