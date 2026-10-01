'use strict';

function registrar(db, req, acao, entidade, entidadeId = null, detalhes = null) {
  db.prepare(`INSERT INTO auditoria (usuario_id, cliente_id, acao, entidade, entidade_id, detalhes, ip)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.usuario?.id ?? null, req.cliente?.id ?? null, acao, entidade, entidadeId,
      detalhes ? JSON.stringify(detalhes) : null, req.ip ?? null);
}

module.exports = { registrar };
