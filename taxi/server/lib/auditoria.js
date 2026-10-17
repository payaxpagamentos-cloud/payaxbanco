'use strict';

const { agora } = require('../db');

/** Registra uma ação da central ou do sistema (quem, o quê e de onde). */
function registrar(db, req, acao, detalhes) {
  db.prepare('INSERT INTO auditoria (usuario_id, acao, detalhes, ip, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(req?.usuario?.id ?? null, acao, detalhes === undefined ? null : JSON.stringify(detalhes), req?.ip ?? null, agora());
}

module.exports = { registrar };
