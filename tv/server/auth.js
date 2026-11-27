'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');

const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

/** Token assinado (HMAC) com o id do usuário e a validade. O perfil de acesso é sempre lido do banco. */
function emitirToken(usuario) {
  const ttl = usuario.perfil === 'assinante' ? config.tokenTtlSeconds : config.tokenOperacaoTtlSeconds;
  // `em` é o instante da emissão, em milissegundos: é o que permite derrubar as sessões
  // anteriores a uma troca de senha (ver `sessoes_desde_ms` em `autenticar`).
  const payload = Buffer.from(JSON.stringify({ sub: usuario.id, aud: 'tv', em: Date.now(), exp: Math.floor(Date.now() / 1000) + ttl })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

/**
 * Encerra todas as sessões abertas de uma conta: tokens emitidos até agora deixam de valer.
 * É o que se chama quando a senha muda — por quem é dono da conta ou pela operação.
 */
function encerrarSessoes(db, usuarioId) {
  db.prepare('UPDATE usuarios SET sessoes_desde_ms = ? WHERE id = ?').run(Date.now(), Number(usuarioId));
}

function lerToken(token) {
  const [payload, assinatura] = String(token ?? '').split('.');
  if (!payload || !assinatura) return null;
  const esperado = Buffer.from(assinar(payload));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return dados.aud === 'tv' && dados.exp > Date.now() / 1000 ? dados : null;
  } catch {
    return null;
  }
}

function autenticar(db) {
  const buscar = db.prepare('SELECT id, nome, email, telefone, perfil, ativo, sessoes_desde_ms FROM usuarios WHERE id = ?');
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null);
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const linha = buscar.get(dados.sub);
    if (!linha || !linha.ativo) return next(new ErroNegocio('Conta desativada.', 401));
    // Senha trocada depois da emissão deste token: a sessão acabou. Token antigo, de antes de
    // existir o campo `em`, só é recusado se a conta já teve as sessões encerradas alguma vez —
    // assim a atualização da plataforma não desloga ninguém à toa.
    if (linha.sessoes_desde_ms && !(Number(dados.em) >= linha.sessoes_desde_ms)) {
      return next(new ErroNegocio('Sua senha foi trocada. Entre de novo.', 401));
    }
    const { sessoes_desde_ms: _desde, ...usuario } = linha;
    req.usuario = usuario;
    next();
  };
}

/** Restringe a rota aos perfis de acesso informados. */
const permitir = (...perfis) => (req, _res, next) =>
  perfis.includes(req.usuario?.perfil) ? next() : next(new ErroNegocio('Seu perfil não tem permissão para esta operação.', 403));

/**
 * Chave do perfil protegido por PIN: depois de digitar o PIN uma vez, o aparelho recebe esta
 * chave assinada e continua usando o perfil sem pedir o PIN em cada tela.
 */
function chavePerfil(perfil, ttlSegundos = 12 * 60 * 60) {
  const payload = Buffer.from(JSON.stringify({ p: perfil.id, u: perfil.usuario_id, exp: Math.floor(Date.now() / 1000) + ttlSegundos })).toString('base64url');
  return `${payload}.${assinar(`perfil:${payload}`)}`;
}

function conferirChavePerfil(perfil, valor) {
  const [payload, assinatura] = String(valor ?? '').split('.');
  if (!payload || !assinatura) return false;
  const esperado = Buffer.from(assinar(`perfil:${payload}`));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.p === perfil.id && d.u === perfil.usuario_id && d.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

/**
 * Perfil de visualização escolhido na TV, informado no cabeçalho X-Perfil (ou ?perfil=).
 * Confere se é da própria conta; sem indicação, usa o principal.
 */
function comPerfilVisualizacao(db) {
  const porId = db.prepare('SELECT * FROM perfis WHERE id = ? AND usuario_id = ?');
  const principal = db.prepare('SELECT * FROM perfis WHERE usuario_id = ? ORDER BY principal DESC, id LIMIT 1');
  return (req, _res, next) => {
    if (req.usuario.perfil !== 'assinante') {
      // A operação assiste para conferir o sinal e o conteúdo, e para isso precisa de um perfil
      // como qualquer outro. O comentário aqui dizia "criado na hora" — e não criava: a conta da
      // operação não tem linha em `perfis`, então isto ficava NULO e toda chamada de /api/tv/*
      // e /play/abrir estourava com 500. Só não aparecia porque a tela do painel não usa essas
      // rotas; quem da equipe abrisse o app do assinante batia na parede.
      let p = principal.get(req.usuario.id);
      if (!p) {
        db.prepare(`INSERT INTO perfis (usuario_id, nome, avatar, infantil, classificacao_max, principal, criado_em)
          VALUES (?, 'Operação', 'gato', 0, 18, 1, ?)`).run(req.usuario.id, new Date().toISOString());
        p = principal.get(req.usuario.id);
      }
      req.perfilView = p;
      return next();
    }
    const pedido = req.get('x-perfil') || req.query.perfil;
    const p = pedido ? porId.get(Number(pedido), req.usuario.id) : principal.get(req.usuario.id);
    if (!p) return next(new ErroNegocio('Escolha um perfil de visualização.', 409));
    // Perfil com PIN só vale com a chave que a tela recebe ao digitar o PIN.
    if (p.pin_hash && !conferirChavePerfil(p, req.get('x-perfil-chave'))) {
      return next(new ErroNegocio(`O perfil "${p.nome}" pede PIN.`, 423, { perfil_id: p.id, pin: true }));
    }
    req.perfilView = p;
    next();
  };
}

module.exports = { emitirToken, lerToken, encerrarSessoes, autenticar, permitir, comPerfilVisualizacao, chavePerfil, conferirChavePerfil };
