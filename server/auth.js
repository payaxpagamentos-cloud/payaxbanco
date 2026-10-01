'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const b64 = (s) => Buffer.from(s).toString('base64url');
const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

function assinarToken(dados, ttl) {
  const payload = b64(JSON.stringify({ ...dados, exp: Math.floor(Date.now() / 1000) + ttl }));
  return `${payload}.${assinar(payload)}`;
}

/** Token da equipe (Banqueiro). */
const emitirToken = (usuario) => assinarToken({ sub: usuario.id, perfil: usuario.perfil, aud: 'equipe' }, config.tokenTtlSeconds);

/** Token do cliente (Internet Banking): audiência própria e validade curta. */
const emitirTokenCliente = (clienteId) => assinarToken({ sub: clienteId, aud: 'cliente' }, config.tokenClienteTtlSeconds);

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
    if (!dados || dados.aud !== 'equipe') return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const usuario = buscar.get(dados.sub);
    if (!usuario || !usuario.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    req.usuario = usuario;
    next();
  };
}

/** Autentica o cliente do Internet Banking e carrega req.cliente e req.acesso. */
function autenticarCliente(db) {
  const buscar = db.prepare(`SELECT c.id, c.nome, c.documento, c.tipo, c.status AS cliente_status, a.id AS acesso_id, a.status, a.precisa_trocar_senha
    FROM clientes c JOIN acessos_cliente a ON a.cliente_id = c.id WHERE c.id = ?`);
  return (req, _res, next) => {
    const cabecalho = req.get('authorization') || '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
    const dados = token && lerToken(token);
    if (!dados || dados.aud !== 'cliente') return next(new ErroNegocio('Sessão expirada. Entre novamente.', 401));
    const c = buscar.get(dados.sub);
    if (!c || c.status !== 'ativo' || c.cliente_status !== 'ativo') return next(new ErroNegocio('Acesso bloqueado. Procure a PAY AX.', 401));
    req.cliente = { id: c.id, nome: c.nome, documento: c.documento, tipo: c.tipo };
    req.acesso = { id: c.acesso_id, precisa_trocar_senha: Boolean(c.precisa_trocar_senha) };
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil)
    ? next()
    : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

module.exports = { emitirToken, emitirTokenCliente, lerToken, autenticar, autenticarCliente, permitir };
