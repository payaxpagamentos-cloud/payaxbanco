'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { manutencao } = require('./lib/manutencao');
const regua = require('./lib/regua');
const { processarFila } = require('./lib/envio');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[ZOE Atende] Painel: http://localhost:${config.port}${config.basePath}/`);
  if (!config.ia.chave) console.log('[ZOE Atende] Sem ATEND_IA_CHAVE: a ZOE roda só com as intenções e a base de conhecimento.');
});

// A fila de saída também gira sozinha: uma mensagem que falhou volta a ser tentada mesmo sem ninguém no painel.
setInterval(() => { processarFila(db).catch((err) => console.error('[ZOE Atende] Falha na fila de envio:', err.message)); }, 20_000).unref();

// Encerra conversas abandonadas, cobra o CSAT e limpa os registros antigos.
setInterval(() => {
  manutencao(db).catch((err) => console.error('[ZOE Atende] Falha na manutenção:', err.message));
}, 60_000).unref();

// Réguas de mensagens ativas: cada uma roda na hora que a empresa marcou, uma vez por dia.
setInterval(async () => {
  for (const r of regua.devemRodar(db)) {
    const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(r.empresa_id);
    try {
      const resultado = await regua.executar(db, empresa, r);
      console.log(`[ZOE Atende] Régua "${r.nome}" (${r.empresa_nome}): ${resultado.enviados} enviada(s), `
        + `${resultado.pela_janela} pela janela, ${resultado.pulados} pulada(s), `
        + `custo ${(resultado.custo_milesimos / 1000).toFixed(2)}, economia ${(resultado.economia_milesimos / 1000).toFixed(2)}`
        + `${resultado.teto_atingido ? ' — PAROU NO TETO DE GASTO' : ''}`);
    } catch (err) {
      console.error(`[ZOE Atende] Falha na régua "${r.nome}":`, err.message);
    }
  }
}, 60_000).unref();
