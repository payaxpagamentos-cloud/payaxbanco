'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

/** Token assinado (HMAC) com o id do usuário e a validade. Perfil, empresa e situação são sempre lidos do banco. */
function emitirToken(usuario) {
  const payload = Buffer.from(JSON.stringify({ sub: usuario.id, aud: 'rastreador', exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

/** Token do app do motorista: outro público ("rastreador-motorista"), com o id do motorista. */
function emitirTokenMotorista(motorista) {
  const payload = Buffer.from(JSON.stringify({ sub: motorista.id, aud: 'rastreador-motorista', exp: Math.floor(Date.now() / 1000) + 30 * 86_400 })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

function lerToken(token, aud = 'rastreador') {
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

/** App do motorista: o motorista ativo, de empresa ativa, com o app liberado (senha cadastrada). */
function autenticarMotorista(db) {
  const buscar = db.prepare(`SELECT m.*, e.nome AS empresa_nome, e.status AS empresa_status FROM motoristas m JOIN empresas e ON e.id = m.empresa_id WHERE m.id = ?`);
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null, 'rastreador-motorista');
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const m = buscar.get(dados.sub);
    if (!m || !m.ativo || !m.senha_hash || m.empresa_status !== 'ativa') return next(new ErroNegocio('Acesso do motorista desativado.', 401));
    req.motorista = m;
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

/**
 * Acesso ao painel de uma empresa (/empresas/:eid): a equipe da plataforma entra em qualquer empresa não excluída;
 * cliente e operador, só na própria. O operador consulta, trata os alertas e pergunta ao assistente, sem alterar cadastros nem enviar comandos.
 */
function acessoEmpresa(db) {
  const buscar = db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'");
  return (req, _res, next) => {
    const u = req.usuario;
    const eid = Number(req.params.eid);
    if (!PLATAFORMA.includes(u.perfil) && u.empresa_id !== eid) return next(new ErroNegocio('Empresa não encontrada.', 404));
    const empresa = Number.isInteger(eid) ? buscar.get(eid) : null;
    if (!empresa) return next(new ErroNegocio('Empresa não encontrada.', 404));
    if (u.perfil === 'operador' && req.method !== 'GET' && !/^\/(alertas|assistente)(\/|$)/.test(req.path)) {
      return next(new ErroNegocio('O operador só consulta e trata alertas.', 403));
    }
    req.empresa = empresa;
    next();
  };
}

module.exports = { emitirToken, emitirTokenMotorista, lerToken, autenticar, autenticarMotorista, permitir, acessoEmpresa, PLATAFORMA };
