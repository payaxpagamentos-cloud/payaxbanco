'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { agora } = require('./db');
const { ErroNegocio } = require('./lib/erros');

const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

/** Token assinado (HMAC) com o id do usuário e a validade. Perfil, empresa e situação são sempre lidos do banco. */
function emitirToken(usuario) {
  const payload = Buffer.from(JSON.stringify({ sub: usuario.id, aud: 'atend', exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds })).toString('base64url');
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
    return dados.aud === 'atend' && dados.exp > Date.now() / 1000 ? dados : null;
  } catch {
    return null;
  }
}

// Equipe da plataforma (sem empresa): vê e administra todas as empresas.
const PLATAFORMA = ['master', 'suporte'];
// Perfis que só consultam: nada de alterar, enviar mensagem ou ver segredos.
const SO_LEITURA = ['supervisor'];

function autenticar(db) {
  const buscar = db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.empresa_id, u.ativo, u.disponivel, u.max_simultaneas,
      e.nome AS empresa_nome, e.status AS empresa_status
    FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id WHERE u.id = ?`);
  const visto = db.prepare('UPDATE usuarios SET visto_em = ? WHERE id = ?');
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null);
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const usuario = buscar.get(dados.sub);
    if (!usuario || !usuario.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    if (usuario.empresa_id && usuario.empresa_status !== 'ativa') return next(new ErroNegocio('Empresa bloqueada. Fale com o suporte.', 401));
    req.usuario = usuario;
    // "Visto em" alimenta a lista de atendentes online do painel; grava no máximo a cada minuto.
    if (!usuario.visto_em || Date.now() - Date.parse(usuario.visto_em) > 60_000) { try { visto.run(agora(), usuario.id); } catch { /* leitura não deve falhar por isso */ } }
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

/**
 * Acesso ao painel de uma empresa (/empresas/:eid): a equipe da plataforma entra em qualquer empresa não excluída;
 * os usuários da empresa, só na própria. O supervisor apenas consulta.
 */
function acessoEmpresa(db) {
  const buscar = db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'");
  return (req, _res, next) => {
    const u = req.usuario;
    const eid = Number(req.params.eid);
    if (!PLATAFORMA.includes(u.perfil) && u.empresa_id !== eid) return next(new ErroNegocio('Empresa não encontrada.', 404));
    const empresa = Number.isInteger(eid) ? buscar.get(eid) : null;
    if (!empresa) return next(new ErroNegocio('Empresa não encontrada.', 404));
    if (SO_LEITURA.includes(u.perfil) && req.method !== 'GET') return next(new ErroNegocio('O supervisor só pode consultar.', 403));
    req.empresa = empresa;
    next();
  };
}

/** Quem pode administrar a empresa (configurações, filas, IA, usuários, números): não o atendente. */
const administraEmpresa = (u) => PLATAFORMA.includes(u.perfil) || u.perfil === 'cliente';
const exigirAdminEmpresa = (req, _res, next) =>
  administraEmpresa(req.usuario) ? next() : next(new ErroNegocio('Só o administrador da empresa pode alterar esta configuração.', 403));

module.exports = { emitirToken, lerToken, autenticar, permitir, acessoEmpresa, administraEmpresa, exigirAdminEmpresa, PLATAFORMA, SO_LEITURA };
