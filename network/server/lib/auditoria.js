'use strict';

const { agora } = require('../db');

const SENSIVEL = /senha|segredo|token|chave|credencial|authorization|api_key/i;
/** Remove campos sensíveis antes de gravar no histórico. */
function limpar(obj) {
  if (obj === undefined || obj === null) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(limpar);
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, SENSIVEL.test(k) ? '[oculto]' : limpar(v)]));
}

/** Registra uma ação: quem, em que organização, sobre qual recurso, o valor antes e depois e o request ID. */
function registrar(db, req, acao, { recurso = null, recursoId = null, antes, depois, organizacaoId } = {}) {
  const org = organizacaoId ?? req?.usuario?.organizacao_id ?? null;
  db.prepare(`INSERT INTO auditoria (organizacao_id, usuario_id, acao, recurso, recurso_id, antes, depois, request_id, ip, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, req?.usuario?.id ?? null, acao, recurso, recursoId === null ? null : Number(recursoId),
    antes === undefined ? null : JSON.stringify(limpar(antes)), depois === undefined ? null : JSON.stringify(limpar(depois)),
    req?.requestId ?? null, req?.ip ?? null, agora());
}

module.exports = { registrar, limpar };
