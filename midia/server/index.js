'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { manutencao } = require('./lib/monitor');
const { faturarAutomatico } = require('./lib/faturamento');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[Mídia Indoor] Painel: http://localhost:${config.port}${config.basePath}/`);
  console.log(`[Mídia Indoor] Player da TV: http://localhost:${config.port}${config.basePath}/tv/`);
});

// Marca as TVs que pararam de falar com o servidor, encerra campanhas vencidas e expira códigos de pareamento.
setInterval(() => {
  try {
    const m = manutencao(db);
    if (m.offline.length) console.log(`[Mídia Indoor] TVs offline: ${m.offline.map((t) => t.nome).join(', ')}`);
    if (m.encerradas) console.log(`[Mídia Indoor] Campanhas encerradas por fim de período: ${m.encerradas}`);
  } catch (err) {
    console.error('[Mídia Indoor] Falha na manutenção:', err.message);
  }
}, 60_000).unref();

// Faturas do mês fechado: gera na virada (quem fatura confere e marca como paga no painel).
const faturar = () => {
  try {
    const r = faturarAutomatico(db);
    if (r.geradas) console.log(`[Mídia Indoor] Faturas geradas (${r.competencia}): ${r.geradas}; repasses: ${r.repasses}`);
  } catch (err) {
    console.error('[Mídia Indoor] Falha ao gerar faturas:', err.message);
  }
};
setInterval(faturar, 6 * 3_600_000).unref();
setTimeout(faturar, 120_000).unref();
