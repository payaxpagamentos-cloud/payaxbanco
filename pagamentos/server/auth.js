'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');
const { assinar } = require('./lib/cripto');
const { podeEquipe, podeCliente, permissoesEquipe, permissoesCliente } = require('./lib/permissoes');

/*
 * Dois tokens com audiências diferentes: o da nossa equipe ('payax') não vale no Internet Bank do cliente
 * ('payax-cliente') e vice-versa. Perfil, situação e cliente são sempre lidos do banco a cada requisição —
 * o token carrega só o id e a validade.
 */
function emitirToken(id, aud) {
  const payload = Buffer.from(JSON.stringify({ sub: id, aud, exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

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

const tokenDoPedido = (req) => {
  const c = req.get('authorization') || '';
  return c.startsWith('Bearer ') ? c.slice(7) : null;
};

/** Sessão da equipe PayAx. */
function autenticarEquipe(db) {
  const buscar = db.prepare('SELECT id, nome, email, perfil, ativo, senha_provisoria FROM usuarios WHERE id = ?');
  return (req, _res, next) => {
    const dados = lerToken(tokenDoPedido(req), 'payax');
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const u = buscar.get(dados.sub);
    if (!u || !u.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    req.usuario = u;
    req.usuarioTipo = 'equipe';
    next();
  };
}

/** Sessão do cliente final (Internet Bank): sempre amarrada ao cliente dono do usuário. */
function autenticarCliente(db) {
  const buscar = db.prepare(`SELECT uc.id, uc.nome, uc.email, uc.perfil, uc.ativo, uc.senha_provisoria, uc.cliente_id,
      c.razao_social, c.nome_fantasia, c.cnpj, c.situacao AS cliente_situacao
    FROM usuarios_cliente uc JOIN clientes c ON c.id = uc.cliente_id WHERE uc.id = ?`);
  return (req, _res, next) => {
    const dados = lerToken(tokenDoPedido(req), 'payax-cliente');
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const u = buscar.get(dados.sub);
    if (!u || !u.ativo) return next(new ErroNegocio('Acesso inativo. Fale com o seu gerente de conta.', 401));
    if (u.cliente_situacao === 'encerrado') return next(new ErroNegocio('Conta encerrada.', 403));
    req.usuario = u;
    req.usuarioTipo = 'cliente';
    req.clienteId = u.cliente_id;
    next();
  };
}

/** Exige a permissão (tabela em lib/permissoes.js), conforme o tipo de sessão. */
const exigir = (...permissoes) => (req, _res, next) => {
  const checar = req.usuarioTipo === 'cliente' ? podeCliente : podeEquipe;
  return permissoes.some((p) => checar(req.usuario?.perfil, p))
    ? next()
    : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));
};

/** Dados da sessão devolvidos ao navegador no login. */
const sessaoEquipe = (u) => ({
  id: u.id, nome: u.nome, email: u.email, perfil: u.perfil,
  perfil_nome: { admin: 'Administrador', financeiro: 'Financeiro', operacao: 'Operação', consulta: 'Consulta' }[u.perfil] ?? u.perfil,
  senha_provisoria: Boolean(u.senha_provisoria),
  permissoes: permissoesEquipe(u.perfil),
});

const sessaoCliente = (u) => ({
  id: u.id, nome: u.nome, email: u.email, perfil: u.perfil,
  perfil_nome: { admin: 'Administrador', operador: 'Operador', consulta: 'Consulta' }[u.perfil] ?? u.perfil,
  senha_provisoria: Boolean(u.senha_provisoria),
  cliente_id: u.cliente_id,
  cliente_nome: u.nome_fantasia || u.razao_social,
  cliente_cnpj: u.cnpj,
  cliente_situacao: u.cliente_situacao,
  permissoes: permissoesCliente(u.perfil),
});

module.exports = { emitirToken, lerToken, autenticarEquipe, autenticarCliente, exigir, sessaoEquipe, sessaoCliente };
