'use strict';

/** Registra uma ação na trilha de auditoria. */
function registrar(db, req, acao, detalhes = {}, empresaId = null) {
  db.prepare('INSERT INTO auditoria (usuario_id, empresa_id, acao, detalhes, ip) VALUES (?, ?, ?, ?, ?)')
    .run(req?.usuario?.id ?? null, empresaId, acao, JSON.stringify(detalhes), req?.ip ?? null);
}

module.exports = { registrar };
