'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { emitirToken } = require('../auth');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');

const publico = (u) => ({ id: u.id, nome: u.nome, email: u.email, telefone: u.telefone, perfil: u.perfil, morador_id: u.morador_id });

module.exports = (db, autenticado) => {
  const r = Router();

  r.post('/login', (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(req.body.email ?? '').trim());
    if (!u || !verificarSenha(String(req.body.senha ?? ''), u.senha_hash)) throw new ErroNegocio('E-mail ou senha incorretos.', 401);
    if (!u.ativo) throw new ErroNegocio('Conta desativada. Fale com a administração.', 403);
    db.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora(), u.id);
    registrar(db, { ...req, usuario: u }, 'login', u.email);
    res.json({ token: emitirToken(u, { lembrar: req.body.lembrar === true }), usuario: publico(u) });
  });

  r.get('/me', autenticado, (req, res) => res.json({ usuario: publico(req.usuario) }));

  r.patch('/me', autenticado, (req, res) => {
    const d = req.body;
    if (d.nome !== undefined) db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(v.texto(d.nome, 'o nome', 120), req.usuario.id);
    if (d.telefone !== undefined) db.prepare('UPDATE usuarios SET telefone = ? WHERE id = ?').run(v.telefoneOpcional(d.telefone), req.usuario.id);
    res.json({ usuario: publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuario.id)) });
  });

  r.post('/senha', autenticado, (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body.atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(req.body.nova)), req.usuario.id);
    registrar(db, req, 'senha_alterada');
    res.status(204).end();
  });

  return r;
};
