'use strict';

const crypto = require('node:crypto');
const { agora } = require('../db');
const { hashSenha } = require('./senha');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');

const PLATAFORMA = ['master', 'suporte'];

/** Cria um usuário. Perfis da plataforma (master, suporte) sem empresa; admin, supervisor e operador sempre de uma empresa. */
function criarUsuario(db, d, { perfis, empresaId = null }) {
  const perfil = v.opcao(d.perfil, 'o perfil', perfis);
  const email = v.email(d.email);
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe um usuário com este e-mail.', 409);
  const plataforma = PLATAFORMA.includes(perfil);
  const lojaId = plataforma ? null : lojaDaEmpresa(db, empresaId, d.loja_id);
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, loja_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(v.texto(d.nome, 'o nome', 120), email, hashSenha(v.senha(d.senha)), perfil, plataforma ? null : empresaId, lojaId, agora());
  return Number(r.lastInsertRowid);
}

/** Alteração de nome, perfil, loja, situação e senha (opcional) de um usuário existente. */
function alterarUsuario(db, u, d, { perfis }) {
  if (d.nome !== undefined) db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(v.texto(d.nome, 'o nome', 120), u.id);
  if (d.perfil !== undefined && d.perfil !== u.perfil) {
    v.opcao(d.perfil, 'o perfil', perfis);
    v.exigir(PLATAFORMA.includes(d.perfil) === PLATAFORMA.includes(u.perfil), 'Não é possível mover o usuário entre a plataforma e uma empresa.');
    db.prepare('UPDATE usuarios SET perfil = ? WHERE id = ?').run(d.perfil, u.id);
  }
  if (d.loja_id !== undefined && u.empresa_id) db.prepare('UPDATE usuarios SET loja_id = ? WHERE id = ?').run(lojaDaEmpresa(db, u.empresa_id, d.loja_id), u.id);
  if (d.ativo !== undefined) db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(v.booleano(d.ativo) ? 1 : 0, u.id);
  if (d.senha) db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(d.senha)), u.id);
}

/** Loja informada, conferindo que é da empresa. Vazio = sem loja fixa (acessa todas as da empresa). */
function lojaDaEmpresa(db, empresaId, lojaId) {
  if (lojaId === undefined || lojaId === null || lojaId === '') return null;
  const loja = db.prepare('SELECT id FROM lojas WHERE id = ? AND empresa_id = ?').get(Number(lojaId), empresaId);
  if (!loja) throw new ErroNegocio('Loja não encontrada nesta empresa.', 422);
  return loja.id;
}

const hashChave = (segredo) => crypto.createHash('sha256').update(segredo).digest('hex');

/** Chave da maquininha: pdv_<prefixo>_<segredo>. Só o hash do segredo fica guardado; a chave aparece uma única vez. */
function gerarChaveTerminal(db, terminalId) {
  const prefixo = crypto.randomBytes(4).toString('hex');
  const segredo = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE terminais SET chave_prefixo = ?, chave_hash = ? WHERE id = ?').run(prefixo, hashChave(segredo), terminalId);
  return { prefixo, chave: `pdv_${prefixo}_${segredo}` };
}

/** Maquininha dona da chave informada, se a chave existe, a maquininha está ativa e a empresa não foi excluída. */
function lerChaveTerminal(db, chave) {
  const m = /^pdv_([0-9a-f]{8})_([A-Za-z0-9_-]{20,64})$/.exec(String(chave ?? ''));
  if (!m) return null;
  const t = db.prepare('SELECT * FROM terminais WHERE chave_prefixo = ? AND ativo = 1').get(m[1]);
  if (!t?.chave_hash) return null;
  const esperado = Buffer.from(t.chave_hash, 'hex');
  const recebido = Buffer.from(hashChave(m[2]), 'hex');
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  const empresa = db.prepare("SELECT * FROM empresas WHERE id = ? AND status = 'ativa'").get(t.empresa_id);
  if (!empresa) return null;
  db.prepare('UPDATE terminais SET ultimo_contato = ? WHERE id = ?').run(agora(), t.id);
  return { terminal: t, empresa };
}

module.exports = { criarUsuario, alterarUsuario, lojaDaEmpresa, gerarChaveTerminal, lerChaveTerminal, PLATAFORMA };
