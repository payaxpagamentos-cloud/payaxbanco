'use strict';

const crypto = require('node:crypto');
const { agora } = require('../db');
const { hashSenha } = require('./senha');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');

/** Cria um usuário. Perfis da plataforma (master, suporte) sem empresa; cliente e operador, sempre de uma empresa. */
function criarUsuario(db, d, { perfis, empresaId = null }) {
  const perfil = v.opcao(d.perfil, 'o perfil', perfis);
  const email = v.email(d.email);
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe um usuário com este e-mail.', 409);
  const plataforma = ['master', 'suporte'].includes(perfil);
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.texto(d.nome, 'o nome', 120), email, hashSenha(v.senha(d.senha)), perfil, plataforma ? null : empresaId, agora());
  return Number(r.lastInsertRowid);
}

/** Alteração de nome, perfil, situação e senha (opcional) de um usuário existente. */
function alterarUsuario(db, u, d, { perfis }) {
  if (d.nome !== undefined) db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(v.texto(d.nome, 'o nome', 120), u.id);
  if (d.perfil !== undefined && d.perfil !== u.perfil) {
    v.opcao(d.perfil, 'o perfil', perfis);
    v.exigir(['master', 'suporte'].includes(d.perfil) === ['master', 'suporte'].includes(u.perfil), 'Não é possível mover o usuário entre a plataforma e uma empresa.');
    db.prepare('UPDATE usuarios SET perfil = ? WHERE id = ?').run(d.perfil, u.id);
  }
  if (d.ativo !== undefined) db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(v.booleano(d.ativo) ? 1 : 0, u.id);
  if (d.senha) db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(d.senha)), u.id);
}

/** Chave da API de integração: rst_<prefixo>_<segredo>. Só o hash do segredo fica guardado; a chave aparece uma única vez. */
function criarChave(db, empresaId, nome, usuarioId) {
  const prefixo = crypto.randomBytes(4).toString('hex');
  const segredo = crypto.randomBytes(24).toString('base64url');
  const r = db.prepare('INSERT INTO chaves_api (empresa_id, nome, prefixo, hash, criada_em, criada_por) VALUES (?, ?, ?, ?, ?, ?)')
    .run(empresaId, v.texto(nome, 'o nome da chave', 80), prefixo, hashChave(segredo), agora(), usuarioId ?? null);
  return { id: Number(r.lastInsertRowid), prefixo, chave: `rst_${prefixo}_${segredo}` };
}

const hashChave = (segredo) => crypto.createHash('sha256').update(segredo).digest('hex');

/** Empresa dona da chave informada, se a chave existe, não foi revogada e a empresa não foi excluída. */
function lerChave(db, chave) {
  const m = /^rst_([0-9a-f]{8})_([A-Za-z0-9_-]{20,64})$/.exec(String(chave ?? ''));
  if (!m) return null;
  const k = db.prepare('SELECT * FROM chaves_api WHERE prefixo = ? AND revogada_em IS NULL').get(m[1]);
  if (!k) return null;
  const esperado = Buffer.from(k.hash, 'hex');
  if (!crypto.timingSafeEqual(esperado, Buffer.from(hashChave(m[2]), 'hex'))) return null;
  db.prepare('UPDATE chaves_api SET ultimo_uso = ? WHERE id = ?').run(agora(), k.id);
  return db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'").get(k.empresa_id) ?? null;
}

module.exports = { criarUsuario, alterarUsuario, criarChave, lerChave, hashChave };
