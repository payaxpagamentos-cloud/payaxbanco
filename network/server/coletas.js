'use strict';

const { agora } = require('./db');
const rastreador = require('./conectores/rastreador');
const downdetector = require('./conectores/downdetector');
const cobranca = require('./lib/cobranca');
const prov = require('./lib/provisionamento');

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

/**
 * Fila do provisionamento: executa o que foi pedido ao equipamento e, de tempos em tempos, relê os serviços
 * para achar o que foi mexido por fora do sistema.
 *
 * A trava `rodando` é o que garante que não há duas execuções da fila ao mesmo tempo: dois comandos
 * simultâneos no mesmo concentrador se atropelariam. A releitura respeita o intervalo da organização
 * (0 desliga) e nunca enfileira duas leituras do mesmo serviço.
 */
function iniciarProvisionamento(db) {
  let rodando = false;
  const ciclo = async () => {
    if (rodando) return;
    rodando = true;
    try {
      for (const org of db.prepare('SELECT id, nome, reconciliacao_horas, provisionamento_automatico FROM organizacoes').all()) {
        if (!org.provisionamento_automatico) continue;
        try {
          const r = await prov.processarFila(db, org.id, { maximo: 25 });
          const falhas = r.tarefas.filter((x) => !x.ok && !x.sem_suporte);
          if (falhas.length) console.warn(`[Network] Provisionamento ${org.nome}: ${falhas.length} tarefa(s) com erro (${falhas.map((f) => f.erro_id).join(', ')}).`);
          if (org.reconciliacao_horas) prov.reconciliar(db, org.id, { horas: org.reconciliacao_horas, maximo: 50 });
        } catch (err) {
          console.error(`[Network] Fila de provisionamento (${org.nome}):`, err.message);
        }
      }
    } finally {
      rodando = false;
    }
  };
  setInterval(() => ciclo().catch((err) => console.error('[Network] Agenda do provisionamento:', err.message)), 20_000).unref();
  ciclo().catch(() => {});
}

/**
 * Varredura de sessões: o que mantém o mapa vivo.
 *
 * Custa UMA chamada por concentrador, não uma por assinante — por isso pode rodar de minuto em minuto sem
 * castigar o equipamento. É daqui que saem o verde, o vermelho e a contagem de quedas do dia.
 */
function iniciarSessoes(db) {
  let rodando = false;
  const ultima = new Map();
  const ciclo = async () => {
    if (rodando) return;
    rodando = true;
    try {
      for (const org of db.prepare('SELECT id, nome, sessoes_minutos FROM organizacoes').all()) {
        if (!org.sessoes_minutos) continue;
        const agendado = (ultima.get(org.id) ?? 0) + org.sessoes_minutos * 60_000;
        if (Date.now() < agendado) continue;
        ultima.set(org.id, Date.now());
        for (const eq of prov.concentradoresVarreveis(db, org.id)) {
          try {
            const r = await prov.varrerSessoes(db, org.id, eq.id);
            if (!r.ok && !r.sem_suporte) {
              console.warn(`[Network] Sessões de ${eq.nome} (${org.nome}): ${r.erro} (${r.erro_id}). Nenhum assinante foi marcado como fora do ar.`);
            } else if (r.ok && (r.caiu || r.voltou)) {
              console.log(`[Network] Sessões de ${eq.nome}: ${r.caiu} queda(s), ${r.voltou} retorno(s) em ${r.servicos} serviço(s).`);
            }
          } catch (err) {
            console.error(`[Network] Varredura de sessões (${eq.nome}):`, err.message);
          }
        }
      }
    } finally {
      rodando = false;
    }
  };
  setInterval(() => ciclo().catch((err) => console.error('[Network] Agenda da varredura:', err.message)), 30_000).unref();
  ciclo().catch(() => {});
}

module.exports = { iniciarColetas, iniciarCobranca, iniciarProvisionamento, iniciarSessoes };
