'use strict';

/* Demonstração no navegador: token simples (sem segredo). A versão instalada assina com HMAC-SHA256. */
const config = require('../../server/config');
const { ErroNegocio } = require('../../server/lib/erros');

const emitirToken = (u) => btoa(JSON.stringify({ sub: u.id, exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds }));
function lerToken(t) {
  try {
    const d = JSON.parse(atob(t));
    return d.exp > Date.now() / 1000 ? d : null;
  } catch { return null; }
}
function autenticar(db) {
  return (req, _res, next) => {
    const cab = req.get('authorization') || '';
    const d = cab.startsWith('Bearer ') && lerToken(cab.slice(7));
    if (!d) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const u = db.prepare('SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = ?').get(d.sub);
    if (!u || !u.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    req.usuario = u;
    next();
  };
}
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

module.exports = { emitirToken, lerToken, autenticar, permitir };
