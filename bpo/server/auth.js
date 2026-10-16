'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

/**
 * Tokens assinados com audiência própria:
 * - 'bpo': equipe (com `cfg2fa` quando a 2FA é obrigatória e ainda não foi configurada);
 * - 'portal': responsável da empresa cliente;
 * - '2fa-bpo' / '2fa-portal': desafio de 5 minutos entre a senha e o código do aplicativo.
 */
function emitir(dados, ttl) {
  const payload = Buffer.from(JSON.stringify({ ...dados, exp: Math.floor(Date.now() / 1000) + ttl })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

const emitirToken = (usuario, extra = {}) => emitir({ sub: usuario.id, aud: 'bpo', ...extra }, config.tokenTtlSeconds);
const emitirTokenPortal = (responsavel) => emitir({ sub: responsavel.id, aud: 'portal' }, config.tokenPortalTtlSeconds);
const emitirDesafio2fa = (id, publico) => emitir({ sub: id, aud: `2fa-${publico}`, n: crypto.randomBytes(6).toString('hex') }, 5 * 60);

function lerToken(token, aud) {
  const [payload, assinatura] = String(token ?? '').split('.');
  if (!payload || !assinatura) return null;
  const esperado = Buffer.from(assinar(payload));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return dados.aud === aud && dados.exp > Date.now() / 1000 ? dados : null;
  } catch {
    return null;
  }
}

const bearer = (req) => {
  const c = req.get('authorization') || '';
  return c.startsWith('Bearer ') ? c.slice(7) : null;
};

/** Equipe do BPO. Sessão "só para configurar a 2FA" só alcança as rotas /auth. */
function autenticar(db) {
  const buscar = db.prepare('SELECT id, nome, email, perfil, ativo, totp_ativo, alcada_aprovacao_centavos FROM usuarios WHERE id = ?');
  return (req, _res, next) => {
    const dados = lerToken(bearer(req), 'bpo');
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const usuario = buscar.get(dados.sub);
    if (!usuario || !usuario.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    if (dados.cfg2fa && !usuario.totp_ativo && !req.originalUrl.startsWith('/api/auth/')) {
      return next(new ErroNegocio('Configure a autenticação em duas etapas para continuar.', 403, { configurar_2fa: true }));
    }
    req.usuario = usuario;
    next();
  };
}

/** Responsável da empresa cliente (Portal). Carrega req.responsavel e req.empresa. */
function autenticarPortal(db) {
  const buscar = db.prepare(`SELECT r.*, e.status AS empresa_status FROM responsaveis r JOIN empresas e ON e.id = r.empresa_id
    WHERE r.id = ? AND r.acesso_portal = 1 AND r.ativo = 1`);
  return (req, _res, next) => {
    const dados = lerToken(bearer(req), 'portal');
    const r = dados && buscar.get(dados.sub);
    if (!r) return next(new ErroNegocio('Sessão expirada. Entre novamente.', 401));
    if (!['ativa', 'implantacao'].includes(r.empresa_status)) return next(new ErroNegocio('Acesso indisponível: contrato não está ativo.', 403));
    const trocar = r.precisa_trocar_senha && !req.originalUrl.startsWith('/api/portal/auth/');
    if (trocar) return next(new ErroNegocio('Crie sua nova senha para continuar.', 403, { trocar_senha: true }));
    req.responsavel = r;
    req.empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(r.empresa_id);
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

module.exports = { emitirToken, emitirTokenPortal, emitirDesafio2fa, lerToken, autenticar, autenticarPortal, permitir };
