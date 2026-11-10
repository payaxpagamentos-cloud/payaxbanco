'use strict';

/*
 * Tarefas periódicas do servidor para o tráfego: retirada automática das ações de bloqueio no prazo, fila de avisos,
 * aviso de exportador parado e limpeza dos dados antigos conforme a retenção de cada organização.
 */

const { agora } = require('./db');
const mitigacao = require('./lib/mitigacao');
const avisos = require('./lib/avisos');

const PARADO_MIN = 5;

/** Exportador que enviava e parou há mais de 5 min: um aviso por parada. */
function verificarExportadores(db) {
  const corte = new Date(Date.now() - PARADO_MIN * 60_000).toISOString();
  const parados = db.prepare('SELECT * FROM exportadores_fluxo WHERE ativo = 1 AND ultimo_pacote IS NOT NULL AND ultimo_pacote < ?').all(corte);
  for (const e of parados) {
    const ja = db.prepare("SELECT 1 FROM avisos_envios WHERE organizacao_id = ? AND evento = 'exportador_parado' AND recurso = 'exportador' AND recurso_id = ? AND criado_em > ?")
      .get(e.organizacao_id, e.id, e.ultimo_pacote);
    if (ja) continue;
    const n = avisos.enfileirar(db, e.organizacao_id, 'exportador_parado', { severidade: e.papel === 'borda' ? 'critica' : 'alta', recurso: 'exportador', recursoId: e.id,
      texto: `⚠️ ${e.nome} (${e.ip}) parou de enviar flows. Último pacote: ${e.ultimo_pacote.slice(0, 16).replace('T', ' ')} UTC.\nSem flows, a detecção de ataques deste roteador fica parada.` });
    if (!n) {
      // Sem canal assinando: grava um registro para não repetir a verificação a cada ciclo.
      const canal = db.prepare('SELECT id FROM avisos_canais WHERE organizacao_id = ? LIMIT 1').get(e.organizacao_id);
      if (canal) db.prepare(`INSERT INTO avisos_envios (organizacao_id, canal_id, evento, recurso, recurso_id, texto, status, proxima_tentativa, erro, criado_em)
        VALUES (?, ?, 'exportador_parado', 'exportador', ?, '', 'falha', ?, 'Canal não assina este evento', ?)`).run(e.organizacao_id, canal.id, e.id, agora(), agora());
    }
  }
}

/** Apaga o que passou da retenção (minuto: 8 dias; IP/hora: 400 dias; sessões: 400 dias, por padrão). */
function limpar(db) {
  for (const c of db.prepare('SELECT c.organizacao_id FROM organizacoes o JOIN ddos_config c ON c.organizacao_id = o.id').all()) {
    const cfg = mitigacao.configDdos(db, c.organizacao_id);
    const dias = (n) => new Date(Date.now() - n * 86400_000).toISOString();
    db.prepare('DELETE FROM trafego_minuto WHERE organizacao_id = ? AND minuto < ?').run(c.organizacao_id, dias(cfg.retencao_minuto_dias).slice(0, 16));
    db.prepare('DELETE FROM trafego_ip_hora WHERE organizacao_id = ? AND hora < ?').run(c.organizacao_id, dias(cfg.retencao_hora_dias).slice(0, 16));
    db.prepare('DELETE FROM sessoes_assinantes WHERE organizacao_id = ? AND fim IS NOT NULL AND fim < ?').run(c.organizacao_id, dias(cfg.retencao_sessoes_dias));
    db.prepare('DELETE FROM avisos_envios WHERE organizacao_id = ? AND criado_em < ?').run(c.organizacao_id, dias(90));
    db.prepare('DELETE FROM trafego_tempo_real WHERE organizacao_id = ? AND em < ?').run(c.organizacao_id, new Date(Date.now() - 6 * 3600_000).toISOString());
    db.prepare('DELETE FROM conteudo_minuto WHERE organizacao_id = ? AND minuto < ?').run(c.organizacao_id, dias(cfg.retencao_minuto_dias).slice(0, 16));
    db.prepare('DELETE FROM conteudo_hora WHERE organizacao_id = ? AND hora < ?').run(c.organizacao_id, dias(cfg.retencao_hora_dias).slice(0, 16));
  }
}

function iniciarTarefasTrafego(db) {
  const proteger = (nome, fn) => async () => { try { await fn(); } catch (err) { console.error(`[Network] Tarefa ${nome}:`, err.message); } };
  let enviando = false;
  const timers = [
    setInterval(proteger('retirada de bloqueios', () => mitigacao.expirar(db)), 15_000),
    setInterval(proteger('avisos', async () => {
      if (enviando) return;
      enviando = true;
      try { await avisos.processar(db); } finally { enviando = false; }
    }), 5000),
    setInterval(proteger('exportadores', () => verificarExportadores(db)), 60_000),
    setInterval(proteger('retenção', () => limpar(db)), 3600_000),
  ];
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}

module.exports = { iniciarTarefasTrafego, verificarExportadores, limpar };
