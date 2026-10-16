'use strict';

/** Registra uma ação na trilha de auditoria (equipe ou responsável do Portal). */
function registrar(db, req, acao, detalhes = {}, empresaId = null) {
  db.prepare('INSERT INTO auditoria (usuario_id, responsavel_id, empresa_id, acao, detalhes, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req?.usuario?.id ?? null, req?.responsavel?.id ?? null, empresaId ?? req?.responsavel?.empresa_id ?? null, acao, JSON.stringify(detalhes), req?.ip ?? null);
}

/** Campos alterados: { campo: [antes, depois] }, para o registro de alterações. */
function diferencas(antes, depois, ignorar = []) {
  const d = {};
  for (const k of Object.keys(depois)) {
    if (ignorar.includes(k) || !(k in antes)) continue;
    if (antes[k] !== depois[k]) d[k] = [antes[k], depois[k]];
  }
  return d;
}

module.exports = { registrar, diferencas };
