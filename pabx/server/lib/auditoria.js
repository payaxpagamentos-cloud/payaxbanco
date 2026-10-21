'use strict';

const { agora } = require('../db');

/** Registra uma ação (quem, em qual empresa, o quê e de onde). */
function registrar(db, req, acao, detalhes, empresaId = req?.empresa?.id ?? null) {
  db.prepare('INSERT INTO auditoria (usuario_id, empresa_id, acao, detalhes, ip, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req?.usuario?.id ?? null, empresaId, acao, detalhes === undefined ? null : JSON.stringify(detalhes), req?.ip ?? null, agora());
}

module.exports = { registrar };
