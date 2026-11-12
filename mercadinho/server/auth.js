'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

/** Token assinado (HMAC) com o id do usuário e a validade. O perfil é sempre lido do banco. */
function emitirToken(usuario) {
  const payload = Buffer.from(JSON.stringify({ sub: usuario.id, aud: 'mercadinho', exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

function lerToken(token, publico = 'mercadinho') {
  const [payload, assinatura] = String(token ?? '').split('.');
  if (!payload || !assinatura) return null;
  const esperado = Buffer.from(assinar(payload));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return dados.aud === publico && dados.exp > Date.now() / 1000 ? dados : null;
  } catch {
    return null;
  }
}

function autenticar(db) {
  const buscar = db.prepare('SELECT id, nome, email, telefone, perfil, morador_id, ativo FROM usuarios WHERE id = ?');
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

/**
 * Token do terminal de autoatendimento: vale por um ano e vive no próprio aparelho do balcão.
 * Não é de ninguém — só abre as rotas do terminal, e a administração pode desativá-lo quando quiser.
 */
function emitirTokenTerminal(terminal) {
  const payload = Buffer.from(JSON.stringify({ sub: terminal.id, aud: 'terminal', exp: Math.floor(Date.now() / 1000) + config.terminalTtlSeconds })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

function autenticarTerminal(db) {
  const buscar = db.prepare('SELECT id, nome, ativo, ultimo_uso FROM terminais WHERE id = ?');
  const marcar = db.prepare('UPDATE terminais SET ultimo_uso = ?, ultimo_ip = ? WHERE id = ?');
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null, 'terminal');
    if (!dados) return next(new ErroNegocio('Este terminal precisa ser pareado de novo.', 401));
    const terminal = buscar.get(dados.sub);
    if (!terminal || !terminal.ativo) return next(new ErroNegocio('Terminal desativado pela administração.', 403));
    req.terminal = terminal;
    // Registra o uso no máximo uma vez por minuto (o terminal consulta a maquininha de poucos em poucos segundos).
    if (!terminal.ultimo_uso || Date.now() - Date.parse(terminal.ultimo_uso) > 60_000) marcar.run(new Date().toISOString(), req.ip ?? null, terminal.id);
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

module.exports = { emitirToken, emitirTokenTerminal, lerToken, autenticar, autenticarTerminal, permitir };
