'use strict';

const { lerConfig, transacao } = require('../db');
const { alertar } = require('./alertas');
const { expirar } = require('./comandos');

/**
 * Tarefas de fundo: alerta de veículo sem comunicação (uma vez até ele voltar), expiração dos comandos sem resposta
 * e limpeza das posições e alertas mais antigos que a retenção.
 */
function manutencao(db, { limpar = false } = {}) {
  const cfg = lerConfig(db);
  const agoraMs = Date.now();
  const mudos = db.prepare(`SELECT v.*, e.sem_comunicacao_min FROM veiculos v JOIN empresas e ON e.id = v.empresa_id
    WHERE v.ativo = 1 AND e.status = 'ativa' AND v.rastreador_id IS NOT NULL AND v.comunicacao_em IS NOT NULL AND v.sem_comunicacao_alertado = 0
      AND e.sem_comunicacao_min > 0`).all()
    .filter((x) => agoraMs - Date.parse(x.comunicacao_em) > x.sem_comunicacao_min * 60_000);
  transacao(db, () => {
    for (const x of mudos) {
      const min = Math.round((agoraMs - Date.parse(x.comunicacao_em)) / 60_000);
      alertar(db, x, 'sem_comunicacao', `${x.placa} sem comunicação há ${min >= 120 ? `${Math.floor(min / 60)} h` : `${min} min`}.`, { gps_em: new Date(agoraMs).toISOString() });
      db.prepare('UPDATE veiculos SET sem_comunicacao_alertado = 1 WHERE id = ?').run(x.id);
    }
  });
  const expirados = expirar(db, cfg.comando_expira_horas);
  let apagadas = 0;
  if (limpar) {
    const corte = new Date(agoraMs - cfg.retencao_dias * 86_400_000).toISOString();
    // Em lotes, para não travar o banco com uma exclusão enorme.
    for (let n = 1; n;) {
      n = db.prepare('DELETE FROM posicoes WHERE id IN (SELECT id FROM posicoes WHERE gps_em < ? LIMIT 5000)').run(corte).changes;
      apagadas += n;
    }
    db.prepare('DELETE FROM alertas WHERE ocorrido_em < ? AND tratado_em IS NOT NULL').run(corte);
    db.prepare('DELETE FROM uso_diario WHERE data < ?').run(corte.slice(0, 10));
    db.prepare('DELETE FROM compartilhamentos WHERE expira_em < ?').run(corte);
  }
  return { sem_comunicacao: mudos.length, expirados, apagadas };
}

module.exports = { manutencao };
