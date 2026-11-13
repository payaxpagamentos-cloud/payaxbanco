'use strict';

const { agora } = require('../db');

/** Registra o que mudou (valor antes e depois). Nunca guarda senha, token ou credencial. */
function registrar(db, req, { acao, entidade = null, entidade_id = null, cliente_id = null, antes = null, depois = null }) {
  const limpar = (o) => {
    if (!o || typeof o !== 'object') return o ?? null;
    const c = { ...o };
    for (const k of Object.keys(c)) if (/senha|token|secret|credenc|chave_privada|certificado/i.test(k)) c[k] = '***';
    return c;
  };
  db.prepare(`INSERT INTO auditoria (usuario_id, usuario_tipo, usuario_nome, cliente_id, acao, entidade, entidade_id, antes, depois, ip, request_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      req?.usuario?.id ?? null,
      req?.usuario ? (req.usuarioTipo ?? 'equipe') : 'sistema',
      req?.usuario?.nome ?? 'sistema',
      cliente_id ?? req?.usuario?.cliente_id ?? null,
      acao, entidade, entidade_id,
      antes ? JSON.stringify(limpar(antes)) : null,
      depois ? JSON.stringify(limpar(depois)) : null,
      req?.ip ?? null, req?.requestId ?? null, agora(),
    );
}

module.exports = { registrar };
