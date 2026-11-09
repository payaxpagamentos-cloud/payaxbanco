'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const { lerConfig, transacao } = require('../db');
const { alertar } = require('./alertas');
const { expirar } = require('./comandos');
const agenda = require('./agenda');
const zap = require('./whatsapp');
const relatoriosProgramados = require('./relatoriosProgramados');
const roubo = require('./roubo');

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
  // Sumiço suspeito: estava andando ou com a ignição ligada e parou de comunicar (sinal de bloqueador ou aparelho arrancado).
  const sumicoMs = (cfg.sumico_min || 5) * 60_000;
  const sumidos = db.prepare(`SELECT v.* FROM veiculos v JOIN empresas e ON e.id = v.empresa_id
    WHERE v.ativo = 1 AND e.status = 'ativa' AND v.rastreador_id IS NOT NULL AND v.comunicacao_em IS NOT NULL AND v.sumico_alertado = 0
      AND (v.ignicao = 1 OR v.velocidade_kmh >= 5) AND v.comunicacao_em < ?`).all(new Date(agoraMs - sumicoMs).toISOString())
    // Só a perda recente: depois de 6 h sem sinal vale o alerta comum de "sem comunicação".
    .filter((x) => agoraMs - Date.parse(x.comunicacao_em) < 6 * 3_600_000);
  transacao(db, () => {
    for (const x of sumidos) {
      const min = Math.round((agoraMs - Date.parse(x.comunicacao_em)) / 60_000);
      alertar(db, x, 'sumico_suspeito', `${x.placa} parou de comunicar ${x.velocidade_kmh >= 5 ? `andando a ${Math.round(x.velocidade_kmh)} km/h` : 'com a ignição ligada'} há ${min} min. Pode ser bloqueador de sinal.`,
        { lat: x.lat, lng: x.lng, velocidade_kmh: x.velocidade_kmh, gps_em: new Date(agoraMs).toISOString() });
      db.prepare('UPDATE veiculos SET sumico_alertado = 1 WHERE id = ?').run(x.id);
    }
  });
  // Bloqueio programado e liberações.
  agenda.verificar(db);
  // Mensagens do WhatsApp que ficaram para depois.
  zap.processarFila(db).catch(() => {});
  // Relatórios programados cuja hora chegou (PDF pelo WhatsApp).
  relatoriosProgramados.executar(db).catch((err) => console.error('[Rastreador] Relatório programado:', err.message));
  const expirados = expirar(db, cfg.comando_expira_horas);
  // Corte do Modo Roubo que expirou sem resposta volta a esperar a próxima posição segura.
  if (expirados) transacao(db, () => roubo.aoExpirar(db));
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
    // Registros que só crescem: fila do WhatsApp (o PDF de uma mensagem que falhou sai depois de 1 dia; a mensagem, depois de 90),
    // avisos do app já mandados, condutores encerrados, equipamentos desconhecidos que sumiram e a auditoria (1 ano).
    const dias = (n) => new Date(agoraMs - n * 86_400_000).toISOString();
    db.prepare("UPDATE mensagens SET arquivo = NULL WHERE arquivo IS NOT NULL AND status <> 'pendente' AND criado_em < ?").run(dias(1));
    db.prepare("DELETE FROM mensagens WHERE status <> 'pendente' AND criado_em < ?").run(dias(90));
    db.prepare('DELETE FROM avisos_motorista WHERE criado_em < ?').run(dias(7));
    db.prepare('DELETE FROM condutores WHERE fim IS NOT NULL AND fim < ?').run(corte);
    db.prepare('DELETE FROM desconhecidos WHERE ultimo_contato < ?').run(dias(90));
    db.prepare('DELETE FROM auditoria WHERE criado_em < ?').run(dias(365));
    db.prepare('DELETE FROM relatorios_envios WHERE criado_em < ?').run(dias(365));
    // Estatísticas do planejador de consultas e o arquivo WAL compactado (uma vez por dia, depois da limpeza).
    try { db.exec('PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* banco em memória nos testes */ }
  }
  return { sem_comunicacao: mudos.length, sumico: sumidos.length, expirados, apagadas };
}

module.exports = { manutencao };
