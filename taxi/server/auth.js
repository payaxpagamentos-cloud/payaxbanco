'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

/** Token assinado (HMAC) com o id do usuário e a validade. O perfil é sempre lido do banco. */
function emitirToken(usuario) {
  const payload = Buffer.from(JSON.stringify({ sub: usuario.id, aud: 'taxi', exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

function lerToken(token) {
  const [payload, assinatura] = String(token ?? '').split('.');
  if (!payload || !assinatura) return null;
  const esperado = Buffer.from(assinar(payload));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return dados.aud === 'taxi' && dados.exp > Date.now() / 1000 ? dados : null;
  } catch {
    return null;
  }
}

function autenticar(db) {
  const buscar = db.prepare('SELECT id, nome, email, telefone, perfil, ativo FROM usuarios WHERE id = ?');
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null);
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const usuario = buscar.get(dados.sub);
    if (!usuario || !usuario.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    req.usuario = usuario;
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

module.exports = { emitirToken, lerToken, autenticar, permitir };
