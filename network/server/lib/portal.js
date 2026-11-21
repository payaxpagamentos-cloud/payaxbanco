'use strict';

const crypto = require('node:crypto');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { assinar, sha256 } = require('./cripto');
const { hashSenha, verificarSenha } = require('./senha');
const v = require('./validacao');

/*
 * Portal do assinante: autenticação.
 *
 * Esta é a única porta do sistema que dá para fora da empresa. As decisões abaixo existem por causa disso:
 *
 * 1. PÚBLICO DE TOKEN SEPARADO. O token da equipe diz `aud: 'network'`; o do assinante, `aud: 'portal'`.
 *    Um não é aceito no lugar do outro, nem por engano de middleware. Se um dia uma rota interna for
 *    montada sem o verificador certo, o token do cliente ainda assim não passa.
 *
 * 2. NENHUMA ROTA DO PORTAL ACEITA UM ID DE ASSINANTE. O assinante vem SEMPRE do token. É o que impede a
 *    falha mais comum deste tipo de tela: trocar o número na URL e ver a fatura do vizinho.
 *
 * 3. O PRIMEIRO ACESSO PASSA POR CONVITE. Não há autocadastro: alguém que saiba um CPF não cria acesso à
 *    conta de ninguém. A equipe gera um código, entrega pelo canal que já usa com o cliente, e ele vale
 *    uma vez e expira.
 *
 * 4. TENTATIVA ERRADA CONTA E BLOQUEIA. CPF é um nome de usuário conhecido: sem bloqueio, descobrir a
 *    senha é questão de tempo.
 */

const SESSAO_SEGUNDOS = Number(process.env.NETWORK_PORTAL_TTL) || 8 * 60 * 60;
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MINUTOS = 15;
const CONVITE_HORAS = Number(process.env.NETWORK_CONVITE_HORAS) || 72;
// Sem I, O, 0 e 1: o código é ditado por telefone, e esses quatro são onde as pessoas erram.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------------- Token ---------------- */

function emitirToken(acesso) {
  const payload = Buffer.from(JSON.stringify({
    sub: acesso.assinante_id, org: acesso.organizacao_id, aud: 'portal',
    exp: Math.floor(Date.now() / 1000) + SESSAO_SEGUNDOS,
  })).toString('base64url');
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
    // O público é conferido aqui: um token da equipe nunca vira um token de assinante.
    return dados.aud === 'portal' && dados.exp > Date.now() / 1000 ? dados : null;
  } catch {
    return null;
  }
}

/** Middleware do portal. O assinante sai do token e mais nada o define. */
function autenticar(db) {
  const buscar = db.prepare(`SELECT a.id, a.codigo, a.nome, a.documento, a.email, a.telefone, a.situacao, a.organizacao_id,
      o.nome AS organizacao_nome, o.fuso, ac.id AS acesso_id, ac.ativo AS acesso_ativo
    FROM assinantes a JOIN organizacoes o ON o.id = a.organizacao_id
    LEFT JOIN assinante_acessos ac ON ac.assinante_id = a.id
    WHERE a.id = ? AND a.organizacao_id = ?`);
  return (req, _res, next) => {
    const c = req.get('authorization') || '';
    const dados = lerToken(c.startsWith('Bearer ') ? c.slice(7) : null);
    if (!dados) return next(new ErroNegocio('Sessão expirada. Entre de novo.', 401));
    const assinante = buscar.get(dados.sub, dados.org);
    if (!assinante || !assinante.acesso_id || !assinante.acesso_ativo) {
      return next(new ErroNegocio('Acesso desativado. Fale com o seu provedor.', 401));
    }
    req.assinante = assinante;
    req.org = assinante.organizacao_id;
    next();
  };
}

/* ---------------- Convite ---------------- */

const gerarCodigo = (tamanho = 8) => [...crypto.randomBytes(tamanho)].map((b) => ALFABETO[b % ALFABETO.length]).join('');

/**
 * Gera um convite e devolve o código EM CLARO uma única vez — o banco guarda só o hash.
 * Quem tiver uma cópia do banco não entra na conta de ninguém com ele.
 */
function criarConvite(db, { org, assinanteId, motivo = 'primeiro_acesso', usuarioId = null }) {
  const assinante = db.prepare('SELECT * FROM assinantes WHERE id = ? AND organizacao_id = ?').get(Number(assinanteId), org);
  if (!assinante) throw new ErroNegocio('Assinante não encontrado.', 404);
  const codigo = gerarCodigo();
  const t = agora();
  // Convite anterior em aberto perde a validade: dois códigos vivos dobrariam a janela de ataque.
  db.prepare('UPDATE assinante_convites SET cancelado_em = ? WHERE assinante_id = ? AND usado_em IS NULL AND cancelado_em IS NULL')
    .run(t, assinante.id);
  const id = Number(db.prepare(`INSERT INTO assinante_convites (organizacao_id, assinante_id, codigo_hash, motivo, expira_em, criado_por, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(org, assinante.id, sha256(codigo), motivo, new Date(Date.now() + CONVITE_HORAS * 3600_000).toISOString(), usuarioId, t).lastInsertRowid);
  return {
    id,
    codigo,
    motivo,
    expira_em: db.prepare('SELECT expira_em FROM assinante_convites WHERE id = ?').get(id).expira_em,
    horas: CONVITE_HORAS,
    assinante: { id: assinante.id, nome: assinante.nome, documento: assinante.documento, telefone: assinante.telefone, email: assinante.email },
  };
}

/* ---------------- Entrada ---------------- */

const bloqueado = (acesso) => Boolean(acesso?.bloqueado_ate && acesso.bloqueado_ate > agora());

const minutosRestantes = (acesso) => Math.max(1, Math.ceil((Date.parse(acesso.bloqueado_ate) - Date.now()) / 60000));

/** Candidatos com este documento que já têm acesso criado. */
const candidatos = (db, documento) => db.prepare(`SELECT ac.*, a.nome, a.documento FROM assinante_acessos ac
  JOIN assinantes a ON a.id = ac.assinante_id WHERE a.documento = ? AND ac.ativo = 1`).all(documento);

function registrarFalha(db, acesso) {
  const tentativas = (acesso.tentativas ?? 0) + 1;
  const bloquear = tentativas >= MAX_TENTATIVAS;
  db.prepare('UPDATE assinante_acessos SET tentativas = ?, bloqueado_ate = ? WHERE id = ?')
    .run(bloquear ? 0 : tentativas, bloquear ? new Date(Date.now() + BLOQUEIO_MINUTOS * 60_000).toISOString() : acesso.bloqueado_ate, acesso.id);
}

/**
 * Entra com documento e senha.
 *
 * A mensagem de erro é a MESMA para documento inexistente e senha errada. Mensagens diferentes
 * transformariam a tela num verificador de "este CPF é cliente deste provedor?".
 */
function entrar(db, { documento, senha, ip = null }) {
  const doc = v.digitos(documento);
  const erroGenerico = new ErroNegocio('CPF/CNPJ ou senha incorretos.', 401);
  if (!doc || !senha) throw erroGenerico;

  const lista = candidatos(db, doc);
  for (const acesso of lista) {
    if (bloqueado(acesso)) {
      throw new ErroNegocio(`Muitas tentativas seguidas. Tente de novo em ${minutosRestantes(acesso)} minuto(s).`, 429);
    }
  }
  const acesso = lista.find((x) => x.senha_hash && verificarSenha(String(senha), x.senha_hash));
  if (!acesso) {
    for (const x of lista) registrarFalha(db, x);
    throw erroGenerico;
  }
  const t = agora();
  db.prepare('UPDATE assinante_acessos SET tentativas = 0, bloqueado_ate = NULL, ultimo_acesso = ?, ultimo_ip = ? WHERE id = ?')
    .run(t, ip, acesso.id);
  return { token: emitirToken(acesso), assinante_id: acesso.assinante_id, organizacao_id: acesso.organizacao_id };
}

/**
 * Primeiro acesso ou redefinição: documento + código do convite + nova senha.
 *
 * O código é conferido por comparação de tempo constante contra o hash guardado. Comparar strings com
 * "===" vazaria, pelo tempo de resposta, quantos caracteres iniciais estavam certos.
 */
function ativar(db, { documento, codigo, senha, ip = null }) {
  const doc = v.digitos(documento);
  const erroGenerico = new ErroNegocio('Código inválido, já usado ou expirado. Peça um novo ao seu provedor.', 401);
  const limpo = String(codigo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!doc || !limpo) throw erroGenerico;

  const assinantes = db.prepare('SELECT * FROM assinantes WHERE documento = ?').all(doc);
  if (!assinantes.length) throw erroGenerico;

  const alvo = sha256(limpo);
  let convite = null;
  let assinante = null;
  for (const a of assinantes) {
    const c = db.prepare(`SELECT * FROM assinante_convites WHERE assinante_id = ? AND usado_em IS NULL AND cancelado_em IS NULL
      AND expira_em > ? ORDER BY id DESC LIMIT 1`).get(a.id, agora());
    if (!c) continue;
    const esperado = Buffer.from(c.codigo_hash);
    const recebido = Buffer.from(alvo);
    if (esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido)) { convite = c; assinante = a; break; }
  }
  if (!convite) throw erroGenerico;

  const nova = v.senha(senha);
  const t = agora();
  db.prepare('UPDATE assinante_convites SET usado_em = ? WHERE id = ?').run(t, convite.id);
  db.prepare(`INSERT INTO assinante_acessos (organizacao_id, assinante_id, senha_hash, criado_em, ultimo_acesso, ultimo_ip)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (organizacao_id, assinante_id) DO UPDATE SET senha_hash = excluded.senha_hash, ativo = 1,
      tentativas = 0, bloqueado_ate = NULL, ultimo_acesso = excluded.ultimo_acesso, ultimo_ip = excluded.ultimo_ip`)
    .run(assinante.organizacao_id, assinante.id, hashSenha(nova), t, t, ip);
  const acesso = db.prepare('SELECT * FROM assinante_acessos WHERE assinante_id = ?').get(assinante.id);
  return { token: emitirToken(acesso), assinante_id: assinante.id, primeiro_acesso: convite.motivo === 'primeiro_acesso' };
}

/** Troca de senha de quem já está dentro: exige a senha atual. */
function trocarSenha(db, { assinanteId, atual, nova }) {
  const acesso = db.prepare('SELECT * FROM assinante_acessos WHERE assinante_id = ?').get(assinanteId);
  if (!acesso?.senha_hash || !verificarSenha(String(atual ?? ''), acesso.senha_hash)) {
    throw new ErroNegocio('Senha atual incorreta.', 422);
  }
  db.prepare('UPDATE assinante_acessos SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(nova)), acesso.id);
  return { ok: true };
}

/** Situação do acesso, para a ficha do assinante mostrar à equipe. */
function situacaoDoAcesso(db, assinanteId) {
  const acesso = db.prepare('SELECT * FROM assinante_acessos WHERE assinante_id = ?').get(assinanteId);
  const convite = db.prepare(`SELECT * FROM assinante_convites WHERE assinante_id = ? AND usado_em IS NULL AND cancelado_em IS NULL
    AND expira_em > ? ORDER BY id DESC LIMIT 1`).get(assinanteId, agora());
  return {
    tem_acesso: Boolean(acesso?.senha_hash),
    ativo: Boolean(acesso?.ativo),
    ultimo_acesso: acesso?.ultimo_acesso ?? null,
    bloqueado: bloqueado(acesso),
    bloqueado_ate: acesso?.bloqueado_ate ?? null,
    // O código em si não volta: ele só existiu uma vez, na hora de gerar.
    convite_aberto: convite ? { expira_em: convite.expira_em, motivo: convite.motivo, criado_em: convite.criado_em } : null,
  };
}

const desativar = (db, assinanteId) => {
  db.prepare('UPDATE assinante_acessos SET ativo = 0 WHERE assinante_id = ?').run(assinanteId);
  db.prepare('UPDATE assinante_convites SET cancelado_em = ? WHERE assinante_id = ? AND usado_em IS NULL AND cancelado_em IS NULL').run(agora(), assinanteId);
  return { ativo: false };
};

module.exports = {
  SESSAO_SEGUNDOS, MAX_TENTATIVAS, BLOQUEIO_MINUTOS, CONVITE_HORAS,
  emitirToken, lerToken, autenticar, criarConvite, entrar, ativar, trocarSenha, situacaoDoAcesso, desativar,
};
