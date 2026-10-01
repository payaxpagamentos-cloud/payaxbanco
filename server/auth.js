'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const b64 = (s) => Buffer.from(s).toString('base64url');
const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

function emitirToken(usuario) {
  const payload = b64(JSON.stringify({
    sub: usuario.id,
    perfil: usuario.perfil,
    exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds,
  }));
  return `${payload}.${assinar(payload)}`;
}

function lerToken(token) {
  const [payload, assinatura] = String(token).split('.');
  if (!payload || !assinatura) return null;
  const esperado = Buffer.from(assinar(payload));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!dados.exp || dados.exp < Date.now() / 1000) return null;
    return dados;
  } catch {
    return null;
  }
}

function autenticar(db) {
  const buscar = db.prepare('SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = ?');
  return (req, _res, next) => {
    const cabecalho = req.get('authorization') || '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
    const dados = token && lerToken(token);
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const usuario = buscar.get(dados.sub);
    if (!usuario || !usuario.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    req.usuario = usuario;
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil)
    ? next()
    : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

module.exports = { emitirToken, lerToken, autenticar, permitir };
