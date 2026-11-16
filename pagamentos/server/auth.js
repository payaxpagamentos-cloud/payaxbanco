'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { ErroNegocio } = require('./lib/erros');
const { assinar } = require('./lib/cripto');
const { podeEquipe, podeCliente, permissoesEquipe, permissoesCliente } = require('./lib/permissoes');

/*
 * Dois tokens com audiências diferentes: o da nossa equipe ('payax') não vale na Área do Cliente do cliente
 * ('payax-cliente') e vice-versa. Perfil, situação e cliente são sempre lidos do banco a cada requisição —
 * o token carrega só o id e a validade.
 */
function emitirToken(id, aud, ttlSegundos = config.tokenTtlSeconds, versao = 0) {
  const payload = Buffer.from(JSON.stringify({ sub: id, aud, sv: versao, exp: Math.floor(Date.now() / 1000) + ttlSegundos })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

/**
 * Desafio da segunda etapa: vale 5 minutos e só serve para informar o código.
 * Audiência própria — não abre nenhuma rota do sistema.
 */
const emitirDesafio = (id, area) => emitirToken(id, `payax-2fa-${area}`, 300);
const lerDesafio = (token, area) => lerToken(token, `payax-2fa-${area}`);

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

/**
 * Rotas liberadas com pendência (senha provisória ou 2FA a configurar). Confere o CAMINHO exato, sem a
 * parte depois do "?" — senão "/api/painel?x=/api/auth/eu" passava.
 */
const ROTAS_PENDENCIA = ['eu', 'senha', '2fa/iniciar', '2fa/ativar'];
const liberadoComPendencia = (req, prefixo) => {
  const caminho = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
  return ROTAS_PENDENCIA.some((r) => caminho === `${prefixo}/api/auth/${r}`);
};
const sessaoValida = (dados, u) => Number(dados.sv ?? 0) === Number(u.sessao_versao ?? 0);

/** Sessão da equipe PAY AX. */
function autenticarEquipe(db) {
  const buscar = db.prepare('SELECT id, nome, email, perfil, ativo, senha_provisoria, totp_ativo, sessao_versao FROM usuarios WHERE id = ?');
  return (req, _res, next) => {
    const dados = lerToken(tokenDoPedido(req), 'payax');
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const u = buscar.get(dados.sub);
    if (!u || !u.ativo) return next(new ErroNegocio('Usuário inativo.', 401));
    if (!sessaoValida(dados, u)) return next(new ErroNegocio('Sessão encerrada (a senha ou o acesso mudou). Entre de novo.', 401));
    // Pendências do acesso valem no servidor, não só na tela: com senha provisória ou sem a verificação
    // em duas etapas (quando o administrador exige), só dá para ver a sessão, trocar a senha e configurar o 2FA.
    if (!liberadoComPendencia(req, config.basePath || '')) {
      if (u.senha_provisoria) return next(new ErroNegocio('Defina a sua senha antes de continuar.', 403));
      if (!u.totp_ativo && require('./lib/doisfatores').exigidaEquipe(db)) {
        return next(new ErroNegocio('Configure a verificação em duas etapas antes de continuar.', 403));
      }
    }
    req.usuario = u;
    req.usuarioTipo = 'equipe';
    next();
  };
}

/** Sessão do cliente final (Área do Cliente): sempre amarrada ao cliente dono do usuário. */
function autenticarCliente(db) {
  const buscar = db.prepare(`SELECT uc.id, uc.nome, uc.email, uc.perfil, uc.ativo, uc.senha_provisoria, uc.totp_ativo, uc.cliente_id, uc.sessao_versao,
      c.razao_social, c.nome_fantasia, c.cnpj, c.situacao AS cliente_situacao
    FROM usuarios_cliente uc JOIN clientes c ON c.id = uc.cliente_id WHERE uc.id = ?`);
  return (req, _res, next) => {
    const dados = lerToken(tokenDoPedido(req), 'payax-cliente');
    if (!dados) return next(new ErroNegocio('Sessão inválida ou expirada.', 401));
    const u = buscar.get(dados.sub);
    if (!u || !u.ativo) return next(new ErroNegocio('Acesso inativo. Fale com o seu gerente de conta.', 401));
    if (u.cliente_situacao === 'encerrado') return next(new ErroNegocio('Conta encerrada.', 403));
    if (!sessaoValida(dados, u)) return next(new ErroNegocio('Sessão encerrada (a senha ou o acesso mudou). Entre de novo.', 401));
    // Senha provisória vale só para trocar a senha (no servidor, não só na tela).
    if (u.senha_provisoria && !liberadoComPendencia(req, config.clientePath)) {
      return next(new ErroNegocio('Defina a sua senha antes de continuar.', 403));
    }
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
  totp_ativo: Boolean(u.totp_ativo),
  permissoes: permissoesEquipe(u.perfil),
});

const sessaoCliente = (u) => ({
  id: u.id, nome: u.nome, email: u.email, perfil: u.perfil,
  perfil_nome: { admin: 'Administrador', operador: 'Operador', consulta: 'Consulta' }[u.perfil] ?? u.perfil,
  senha_provisoria: Boolean(u.senha_provisoria),
  totp_ativo: Boolean(u.totp_ativo),
  cliente_id: u.cliente_id,
  cliente_nome: u.nome_fantasia || u.razao_social,
  cliente_cnpj: u.cnpj,
  cliente_situacao: u.cliente_situacao,
  permissoes: permissoesCliente(u.perfil),
});

module.exports = { emitirToken, lerToken, emitirDesafio, lerDesafio, autenticarEquipe, autenticarCliente, exigir, sessaoEquipe, sessaoCliente };
