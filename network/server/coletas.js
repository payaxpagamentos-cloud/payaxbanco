'use strict';

const { agora } = require('./db');
const config = require('./config');
const rastreador = require('./conectores/rastreador');
const downdetector = require('./conectores/downdetector');
const atendimento = require('./conectores/atendimento');

// O ZOE Atende só entra na agenda quando o destino do custo estiver definido (config.custoWhatsapp).
const CONECTORES = { rastreador, downdetector, ...(config.custoWhatsapp ? { atendimento } : {}) };

/**
 * Agenda das coletas: a cada 15 s, roda as integrações habilitadas cuja próxima tentativa chegou (cada coleta define a
 * próxima pelo intervalo ou pelo backoff/Retry-After). Integrações com erro permanente (credencial recusada, endereço errado)
 * ficam paradas até a configuração mudar ou o teste manual. Uma coleta por integração por vez.
 */
function iniciarColetas(db) {
  const rodando = new Set();
  const ciclo = async () => {
    const devidas = db.prepare(`SELECT organizacao_id, tipo, estado, proxima_tentativa FROM integracoes WHERE habilitada = 1
      AND (proxima_tentativa IS NULL AND estado IN ('testando','conectada','parcial') OR proxima_tentativa <= ?)`).all(agora());
    for (const x of devidas) {
      const k = `${x.organizacao_id}:${x.tipo}`;
      if (rodando.has(k)) continue;
      rodando.add(k);
      if (!CONECTORES[x.tipo]) continue;
      CONECTORES[x.tipo].coletar(db, x.organizacao_id).catch(() => { /* estado e erro ficam registrados na integração */ }).finally(() => rodando.delete(k));
    }
  };
  setInterval(() => ciclo().catch((err) => console.error('[Network] Agenda de coletas:', err.message)), 15_000).unref();
  ciclo().catch(() => {});
}

module.exports = { iniciarColetas };
