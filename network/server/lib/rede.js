'use strict';

const { agora } = require('../db');

/** Ativo que alimenta este (ligação ativa para cima). */
const acima = (db, ativoId) => db.prepare(`SELECT e.*, a.codigo AS destino_codigo, a.tipo AS destino_tipo FROM enlaces e JOIN ativos_rede a ON a.id = e.destino_id
  WHERE e.origem_id = ? AND e.fim IS NULL`).get(ativoId);

/**
 * Percurso conhecido do ativo até o POP, seguindo as ligações ativas. Se o caminho termina antes de um POP,
 * o último trecho fica marcado como desconhecido (não é inventado).
 */
function percurso(db, ativoId) {
  const passos = [];
  const vistos = new Set();
  let atual = db.prepare('SELECT id, codigo, tipo, nome, bairro, lat, lng, status_operacional FROM ativos_rede WHERE id = ?').get(ativoId);
  while (atual && !vistos.has(atual.id)) {
    vistos.add(atual.id);
    const lig = acima(db, atual.id);
    passos.push({ ...atual, enlace: lig ? { id: lig.id, cabo_id: lig.cabo_id, fibras: lig.fibras, desde: lig.inicio } : null });
    if (!lig) break;
    atual = db.prepare('SELECT id, codigo, tipo, nome, bairro, lat, lng, status_operacional FROM ativos_rede WHERE id = ?').get(lig.destino_id);
  }
  const ultimo = passos.at(-1);
  return { passos, completo: ultimo?.tipo === 'pop', trecho_desconhecido: ultimo && ultimo.tipo !== 'pop' ? `Sem ligação conhecida de ${ultimo.codigo} até um POP.` : null };
}

/** Todos os ativos alimentados (direta ou indiretamente) por este, pelas ligações ativas. */
function descendentes(db, ativoId) {
  const filhos = db.prepare('SELECT origem_id FROM enlaces WHERE destino_id = ? AND fim IS NULL');
  const r = [];
  const fila = [ativoId];
  const vistos = new Set([ativoId]);
  while (fila.length) {
    const id = fila.shift();
    for (const { origem_id: o } of filhos.all(id)) {
      if (vistos.has(o)) continue;
      vistos.add(o);
      r.push(o);
      fila.push(o);
    }
  }
  return r;
}

/**
 * Impacto provável sobre uma lista de ativos: CTOs alcançadas, portas ocupadas e clientes únicos (pela referência do cliente).
 * O mesmo cliente nunca é contado duas vezes, ainda que apareça por POP, CEO e CTO. Sem referência de cliente, só "portas ocupadas".
 */
function impacto(db, ativoIds) {
  const ids = [...new Set(ativoIds)];
  if (!ids.length) return { ctos: [], portas_ocupadas: 0, clientes_unicos: null, clientes_sem_referencia: 0 };
  const marc = ids.map(() => '?').join(',');
  const ctos = db.prepare(`SELECT id, codigo, bairro FROM ativos_rede WHERE id IN (${marc}) AND tipo = 'cto' AND ativo = 1`).all(...ids);
  const portas = ctos.length ? db.prepare(`SELECT cliente_ref FROM portas_rede WHERE ativo_id IN (${ctos.map(() => '?').join(',')}) AND situacao = 'ocupada' AND em_uso = 1`)
    .all(...ctos.map((c) => c.id)) : [];
  const clientes = new Set(portas.filter((p) => p.cliente_ref).map((p) => p.cliente_ref.trim().toLowerCase()));
  const semRef = portas.filter((p) => !p.cliente_ref).length;
  return { ctos, portas_ocupadas: portas.length, clientes_unicos: clientes.size, clientes_sem_referencia: semRef };
}

/** Reservas vencidas voltam a livre (com histórico). */
function expirarReservas(db, ativoId) {
  const t = agora();
  const vencidas = db.prepare("SELECT * FROM portas_rede WHERE ativo_id = ? AND situacao = 'reservada' AND reserva_expira_em < ?").all(ativoId, t);
  for (const p of vencidas) {
    db.prepare("UPDATE portas_rede SET situacao = 'livre', cliente_ref = NULL, reservado_por = NULL, reserva_expira_em = NULL, desde = ?, versao = versao + 1 WHERE id = ? AND situacao = 'reservada'")
      .run(t, p.id);
    db.prepare("INSERT INTO porta_historico (porta_id, situacao_anterior, situacao, motivo, em) VALUES (?, 'reservada', 'livre', 'Reserva expirada', ?)").run(p.id, t);
  }
}

/**
 * Inferência sobre CTOs passivas a partir de um evento de equipamento ativo (OLT/PON/ONU): marca as CTOs ligadas àquele
 * equipamento/PON com a origem "inferência" e a evidência (equipamento, ponto, valor medido, instante). Não é medição da caixa.
 */
function inferirCtos(db, { organizacaoId, equipamentoId, ponto, status, evidencia, ignorar = null }) {
  const p = [organizacaoId, equipamentoId];
  let f = "organizacao_id = ? AND equipamento_id = ? AND tipo = 'cto' AND ativo = 1";
  if (ponto) { f += ' AND pon = ?'; p.push(ponto); }
  const ctos = db.prepare(`SELECT id FROM ativos_rede WHERE ${f}`).all(...p).filter((c) => !ignorar?.has(c.id));
  for (const c of ctos) {
    db.prepare("UPDATE ativos_rede SET status_operacional = ?, status_origem = 'inferencia', status_evidencia = ?, status_em = ?, status_por = NULL WHERE id = ?")
      .run(status, evidencia, agora(), c.id);
  }
  return ctos.map((c) => c.id);
}

module.exports = { acima, percurso, descendentes, impacto, expirarReservas, inferirCtos };
