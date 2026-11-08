'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');
const { assinar } = require('./lib/cripto');
const { pode } = require('./lib/permissoes');

/** Token assinado (HMAC) com o id do usuário e a validade. Perfil, organização e situação são sempre lidos do banco. */
function emitirToken(usuario) {
  const payload = Buffer.from(JSON.stringify({ sub: usuario.id, aud: 'network', exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds })).toString('base64url');
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
    return dados.aud === 'network' && dados.exp > Date.now() / 1000 ? dados : null;
  } catch {
    return null;
  }
}

function autenticar(db) {
  const buscar = db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.organizacao_id, u.ativo, o.nome AS organizacao_nome, o.fuso, o.demonstracao,
      t.id AS tecnico_id
    FROM usuarios u JOIN organizacoes o ON o.id = u.organizacao_id LEFT JOIN tecnicos t ON t.usuario_id = u.id WHERE u.id = ?`);
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null);
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const usuario = buscar.get(dados.sub);
    if (!usuario || !usuario.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    req.usuario = usuario;
    req.org = usuario.organizacao_id;
    next();
  };
}

/** Exige a permissão na rota (tabela em lib/permissoes.js). */
const exigir = (...permissoes) => (req, _res, next) =>
  permissoes.some((p) => pode(req.usuario?.perfil, p)) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

module.exports = { emitirToken, lerToken, autenticar, exigir };
