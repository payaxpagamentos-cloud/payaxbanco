'use strict';

const { agora } = require('./db');
const rastreador = require('./conectores/rastreador');
const downdetector = require('./conectores/downdetector');
const cobranca = require('./lib/cobranca');

const CONECTORES = { rastreador, downdetector };

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
      CONECTORES[x.tipo].coletar(db, x.organizacao_id).catch(() => { /* estado e erro ficam registrados na integração */ }).finally(() => rodando.delete(k));
    }
  };
  setInterval(() => ciclo().catch((err) => console.error('[Network] Agenda de coletas:', err.message)), 15_000).unref();
  ciclo().catch(() => {});
}

/**
 * Rotina diária da cobrança: expira os desbloqueios de confiança vencidos e aplica a régua.
 *
 * Roda uma vez por dia por organização, pela data no fuso dela, e a execução fica registrada. A verificação é de
 * 10 em 10 minutos só para não depender de o servidor estar de pé num horário exato: se a máquina passou o dia
 * desligada, a rotina roda quando voltar e a régua pega o atraso acumulado sem repetir o que já tinha feito.
 */
function iniciarCobranca(db) {
  let rodando = false;
  const ciclo = () => {
    if (rodando) return;
    rodando = true;
    try {
      for (const org of db.prepare('SELECT id, nome, fuso FROM organizacoes').all()) {
        const hoje = cobranca.rotinaPendente(db, org.id, org.fuso);
        if (!hoje) continue;
        try {
          const r = cobranca.rotinaDiaria(db, org.id, hoje);
          if (r.regua.bloqueios || r.confiancas.expiradas || r.regua.avisos) {
            console.log(`[Network] Cobrança ${hoje} · ${org.nome}: ${r.regua.avisos} aviso(s), ${r.regua.bloqueios} bloqueio(s), ${r.confiancas.expiradas} confiança(s) expirada(s).`);
          }
        } catch (err) {
          console.error(`[Network] Rotina de cobrança (${org.nome}):`, err.message);
        }
      }
    } finally {
      rodando = false;
    }
  };
  setInterval(ciclo, 10 * 60_000).unref();
  ciclo();
}

module.exports = { iniciarColetas, iniciarCobranca };
