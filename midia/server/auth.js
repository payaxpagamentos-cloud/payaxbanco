'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');
const montar = (dados) => {
  const payload = Buffer.from(JSON.stringify(dados)).toString('base64url');
  return `${payload}.${assinar(payload)}`;
};

function abrirToken(token, audiencia) {
  const [payload, assinatura] = String(token ?? '').split('.');
  if (!payload || !assinatura) return null;
  const esperado = Buffer.from(assinar(payload));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (dados.aud !== audiencia) return null;
    if (dados.exp && dados.exp <= Date.now() / 1000) return null;
    return dados;
  } catch {
    return null;
  }
}

/** Sessão do painel: só o id e a validade; perfil, vínculo e situação são sempre lidos do banco. */
const emitirToken = (usuario) => montar({ sub: usuario.id, aud: 'midia', exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds });
const lerToken = (token) => abrirToken(token, 'midia');

/**
 * Token do aparelho (a TV). Não expira — a TV fica ligada meses — mas carrega a versão do pareamento:
 * despareá-la no painel aumenta a versão e o token antigo deixa de valer.
 */
const emitirTokenTela = (tela) => montar({ sub: tela.id, ver: tela.token_versao, aud: 'tela' });
const lerTokenTela = (token) => abrirToken(token, 'tela');

const EQUIPE = ['master', 'administrador', 'operador'];

function autenticar(db) {
  const buscar = db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.anunciante_id, u.local_id, u.ativo, u.empresa_id,
      a.nome AS anunciante_nome, a.status AS anunciante_status, l.nome AS local_nome, l.status AS local_status,
      e.nome AS empresa_nome, e.ativo AS empresa_ativa
    FROM usuarios u
    LEFT JOIN anunciantes a ON a.id = u.anunciante_id
    LEFT JOIN locais l ON l.id = u.local_id
    LEFT JOIN empresas e ON e.id = u.empresa_id
    WHERE u.id = ?`);
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null);
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const usuario = buscar.get(dados.sub);
    if (!usuario || !usuario.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    if (usuario.anunciante_id && usuario.anunciante_status !== 'ativo') return next(new ErroNegocio('Anunciante inativo. Fale com a equipe.', 401));
    if (usuario.local_id && usuario.local_status === 'encerrado') return next(new ErroNegocio('Ponto encerrado. Fale com a equipe.', 401));
    if (usuario.empresa_id && usuario.empresa_ativa === 0) return next(new ErroNegocio('Empresa desativada. Fale com o administrador do sistema.', 401));
    req.usuario = usuario;
    next();
  };
}

/** Restringe a rota aos perfis informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

/** Autentica a TV pelo token do aparelho (o player não tem usuário nem senha). */
function autenticarTela(db) {
  const buscar = db.prepare(`SELECT t.*, l.nome AS local_nome, l.cidade, l.status AS local_status FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.id = ?`);
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerTokenTela(c.startsWith('Bearer ') ? c.slice(7) : null);
    if (!dados) return next(new ErroNegocio('Aparelho não pareado.', 401));
    const tela = buscar.get(dados.sub);
    if (!tela || tela.token_versao !== dados.ver) return next(new ErroNegocio('Aparelho despareado. Peça um novo código.', 401));
    if (tela.status === 'inativa' || tela.local_status === 'encerrado') return next(new ErroNegocio('Tela desativada.', 403));
    req.tela = tela;
    next();
  };
}

module.exports = { emitirToken, lerToken, emitirTokenTela, lerTokenTela, autenticar, autenticarTela, permitir, EQUIPE };
