'use strict';

const { agora, transacao } = require('../db');
const { local } = require('./datas');
const { ErroNegocio } = require('./erros');

const LIMITE_LOTE = 500;

/**
 * Prova de exibição: o player manda em lote o que foi ao ar (ele guarda na fila quando está sem internet).
 * O mesmo registro reenviado não duplica — a chave é tela + mídia + instante.
 */
function registrar(db, tela, lista) {
  if (!Array.isArray(lista)) throw new ErroNegocio('Envie a lista de exibições.', 422);
  if (lista.length > LIMITE_LOTE) throw new ErroNegocio(`Envie no máximo ${LIMITE_LOTE} exibições por vez.`, 413);

  const midias = new Map(db.prepare('SELECT id, anunciante_id FROM midias').all().map((m) => [m.id, m]));
  const campanhas = new Map(db.prepare('SELECT id, anunciante_id FROM campanhas').all().map((c) => [c.id, c]));
  const comunicados = new Set(db.prepare('SELECT id FROM comunicados WHERE local_id = ?').all(tela.local_id).map((c) => c.id));
  const limiteFuturo = Date.now() + 3_600_000;
  const limitePassado = Date.now() - 30 * 86_400_000;

  const inserir = db.prepare(`INSERT OR IGNORE INTO exibicoes (tela_id, local_id, campanha_id, anunciante_id, midia_id, comunicado_id, tipo, data, exibida_em, duracao_s, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const somar = db.prepare(`INSERT INTO resumo_dia (data, tela_id, campanha_id, local_id, insercoes, segundos) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT (data, tela_id, campanha_id) DO UPDATE SET insercoes = insercoes + 1, segundos = segundos + excluded.segundos`);

  return transacao(db, () => {
    let gravadas = 0;
    let repetidas = 0;
    let ignoradas = 0;
    const criado = agora();
    for (const e of lista) {
      const instante = Date.parse(e.exibida_em ?? '');
      const duracao = Math.min(600, Math.max(0, Math.round(Number(e.duracao_s) || 0)));
      if (!Number.isFinite(instante) || instante > limiteFuturo || instante < limitePassado) { ignoradas++; continue; }
      // Um criativo (mídia), um comunicado do próprio ponto, ou a tela da própria rede (sem id).
      const midiaId = e.midia_id ? Number(e.midia_id) : null;
      const comunicadoId = e.comunicado_id ? Number(e.comunicado_id) : null;
      const marca = e.tipo === 'marca' || (midiaId === null && comunicadoId === null && e.tipo === undefined && e.marca === true);
      if (midiaId !== null && !midias.has(midiaId)) { ignoradas++; continue; }
      if (comunicadoId !== null && !comunicados.has(comunicadoId)) { ignoradas++; continue; }
      if (midiaId === null && comunicadoId === null && !marca) { ignoradas++; continue; }
      const campanhaId = e.campanha_id ? Number(e.campanha_id) : null;
      if (campanhaId !== null && !campanhas.has(campanhaId)) { ignoradas++; continue; }
      const iso = new Date(instante).toISOString();
      const data = local(instante).data;
      const anuncianteId = campanhaId !== null ? campanhas.get(campanhaId).anunciante_id : (midiaId !== null ? midias.get(midiaId).anunciante_id : null);
      const tipo = marca ? 'marca' : (comunicadoId !== null ? 'comunicado' : 'midia');
      const r = inserir.run(tela.id, tela.local_id, campanhaId, anuncianteId, midiaId, comunicadoId, tipo, data, iso, duracao, criado);
      if (!r.changes) { repetidas++; continue; }
      somar.run(data, tela.id, campanhaId ?? 0, tela.local_id, duracao);
      gravadas++;
    }
    return { gravadas, repetidas, ignoradas };
  });
}

/** Refaz o resumo do dia a partir das exibições gravadas (usado depois de apagar algo ou corrigir dados). */
function recalcularDia(db, data) {
  return transacao(db, () => {
    db.prepare('DELETE FROM resumo_dia WHERE data = ?').run(data);
    db.prepare(`INSERT INTO resumo_dia (data, tela_id, campanha_id, local_id, insercoes, segundos)
      SELECT data, tela_id, COALESCE(campanha_id, 0), local_id, COUNT(*), SUM(duracao_s) FROM exibicoes WHERE data = ?
      GROUP BY data, tela_id, COALESCE(campanha_id, 0), local_id`).run(data);
    return db.prepare('SELECT COUNT(*) AS n FROM resumo_dia WHERE data = ?').get(data).n;
  });
}

module.exports = { registrar, recalcularDia, LIMITE_LOTE };
