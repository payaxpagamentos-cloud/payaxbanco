'use strict';

const { agora } = require('../db');

/** Registra o que foi feito e por quem (consultado na tela de auditoria). */
function registrar(db, req, acao, detalhes) {
  db.prepare('INSERT INTO auditoria (usuario_id, acao, detalhes, ip, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(req?.usuario?.id ?? null, acao, detalhes ? String(detalhes).slice(0, 500) : null, req?.ip ?? null, agora());
}

module.exports = { registrar };
