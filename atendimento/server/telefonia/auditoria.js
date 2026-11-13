'use strict';

const { auditar } = require('../db');

/**
 * A auditoria da telefonia vai para a mesma auditoria da ZOE: quem, em qual empresa, o quê e de onde.
 * Mantém a assinatura antiga (req, ação, detalhes) para o código da telefonia não mudar.
 */
function registrar(db, req, acao, detalhes, empresaId = req?.empresa?.id ?? null) {
  auditar(db, { usuario: req?.usuario ?? null, empresaId, acao: `telefonia: ${acao}`, detalhe: detalhes ?? null, ip: req?.ip ?? null });
}

module.exports = { registrar };
