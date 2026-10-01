'use strict';

const { Router } = require('express');
const { emitirToken, autenticar } = require('../auth');
const { verificarSenha, hashSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { exigir } = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');

module.exports = (db) => {
  const r = Router();

  r.post('/login', (req, res) => {
    const { email, senha } = req.body ?? {};
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(email ?? '').trim());
    if (!u || !u.ativo || !verificarSenha(senha ?? '', u.senha_hash)) {
      throw new ErroNegocio('E-mail ou senha inválidos.', 401);
    }
    db.prepare("UPDATE usuarios SET ultimo_acesso = datetime('now') WHERE id = ?").run(u.id);
    req.usuario = u;
    registrar(db, req, 'login', 'usuario', u.id);
    res.json({ token: emitirToken(u), usuario: { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil } });
  });

  r.get('/me', autenticar(db), (req, res) => res.json(req.usuario));

  r.post('/senha', autenticar(db), (req, res) => {
    const { senha_atual, nova_senha } = req.body ?? {};
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(senha_atual ?? '', u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    exigir(typeof nova_senha === 'string' && nova_senha.length >= 8, 'A nova senha deve ter pelo menos 8 caracteres.');
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(nova_senha), req.usuario.id);
    registrar(db, req, 'alterar_senha', 'usuario', req.usuario.id);
    res.json({ ok: true });
  });

  return r;
};
