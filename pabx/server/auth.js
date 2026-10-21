'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

/** Token assinado (HMAC) com o id do usuário e a validade. Perfil, empresa e situação são sempre lidos do banco. */
function emitirToken(usuario) {
  const payload = Buffer.from(JSON.stringify({ sub: usuario.id, aud: 'pabx', exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds })).toString('base64url');
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
    return dados.aud === 'pabx' && dados.exp > Date.now() / 1000 ? dados : null;
  } catch {
    return null;
  }
}

const PLATAFORMA = ['master', 'suporte'];

function autenticar(db) {
  const buscar = db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.empresa_id, u.ativo, e.nome AS empresa_nome, e.status AS empresa_status
    FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id WHERE u.id = ?`);
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null);
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const usuario = buscar.get(dados.sub);
    if (!usuario || !usuario.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    if (usuario.empresa_id && usuario.empresa_status !== 'ativa') return next(new ErroNegocio('Empresa bloqueada. Fale com o suporte.', 401));
    req.usuario = usuario;
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

/**
 * Acesso ao painel de uma empresa (/empresas/:eid): a equipe da plataforma entra em qualquer empresa não excluída;
 * cliente e supervisor, só na própria. O supervisor só consulta.
 */
function acessoEmpresa(db) {
  const buscar = db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'");
  return (req, _res, next) => {
    const u = req.usuario;
    const eid = Number(req.params.eid);
    if (!PLATAFORMA.includes(u.perfil) && u.empresa_id !== eid) return next(new ErroNegocio('Empresa não encontrada.', 404));
    const empresa = Number.isInteger(eid) ? buscar.get(eid) : null;
    if (!empresa) return next(new ErroNegocio('Empresa não encontrada.', 404));
    if (u.perfil === 'supervisor' && req.method !== 'GET') return next(new ErroNegocio('O supervisor só pode consultar.', 403));
    req.empresa = empresa;
    next();
  };
}

module.exports = { emitirToken, lerToken, autenticar, permitir, acessoEmpresa, PLATAFORMA };
