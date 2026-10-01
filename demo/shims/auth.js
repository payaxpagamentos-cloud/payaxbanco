'use strict';

/* Demonstração no navegador: token simples (sem segredo). A versão instalada assina com HMAC-SHA256. */
const config = require('../../server/config');
const { ErroNegocio } = require('../../server/lib/erros');

const emitirToken = (u) => btoa(JSON.stringify({ sub: u.id, aud: 'equipe', exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds }));
const emitirTokenCliente = (id) => btoa(JSON.stringify({ sub: id, aud: 'cliente', exp: Math.floor(Date.now() / 1000) + config.tokenClienteTtlSeconds }));
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
    if (!d || d.aud !== 'equipe') return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const u = db.prepare('SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = ?').get(d.sub);
    if (!u || !u.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    req.usuario = u;
    next();
  };
}
function autenticarCliente(db) {
  return (req, _res, next) => {
    const cab = req.get('authorization') || '';
    const d = cab.startsWith('Bearer ') && lerToken(cab.slice(7));
    if (!d || d.aud !== 'cliente') return next(new ErroNegocio('Sessão expirada. Entre novamente.', 401));
    const c = db.prepare(`SELECT c.id, c.nome, c.documento, c.tipo, c.status AS cliente_status, a.id AS acesso_id, a.status, a.precisa_trocar_senha
      FROM clientes c JOIN acessos_cliente a ON a.cliente_id = c.id WHERE c.id = ?`).get(d.sub);
    if (!c || c.status !== 'ativo' || c.cliente_status !== 'ativo') return next(new ErroNegocio('Acesso bloqueado. Procure a PAY AX.', 401));
    req.cliente = { id: c.id, nome: c.nome, documento: c.documento, tipo: c.tipo };
    req.acesso = { id: c.acesso_id, precisa_trocar_senha: Boolean(c.precisa_trocar_senha) };
    next();
  };
}
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

module.exports = { emitirToken, emitirTokenCliente, lerToken, autenticar, autenticarCliente, permitir };
