'use strict';

const { Router } = require('express');
const { transacao, agora } = require('../db');
const { emitirToken } = require('../auth');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const assinaturas = require('../lib/assinaturas');
const v = require('../lib/validacao');

const publico = (u) => ({ id: u.id, nome: u.nome, email: u.email, telefone: u.telefone, perfil: u.perfil });

/** Cadastro, login e a própria conta. */
module.exports = (db, autenticado) => {
  const r = Router();

  const entrar = (id) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    db.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora(), id);
    return {
      token: emitirToken(u),
      usuario: publico(u),
      perfis: db.prepare('SELECT id, nome, cor, infantil, classificacao_max, principal FROM perfis WHERE usuario_id = ? ORDER BY principal DESC, id').all(id),
      assinatura: assinaturas.resumo(db, u),
    };
  };

  /** Quem se cadastra na plataforma é assinante e já ganha o primeiro perfil de visualização. */
  r.post('/cadastro', (req, res) => {
    const d = req.body;
    const email = v.email(d.email);
    const nome = v.texto(d.nome, 'o nome', 120);
    const senha = v.senha(d.senha);
    const telefone = d.telefone ? v.telefone(d.telefone) : null;
    const id = transacao(db, () => {
      if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe uma conta com este e-mail.', 409);
      const res2 = db.prepare("INSERT INTO usuarios (nome, email, telefone, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, 'assinante', ?)")
        .run(nome, email, telefone, hashSenha(senha), agora());
      const uid = Number(res2.lastInsertRowid);
      db.prepare('INSERT INTO perfis (usuario_id, nome, principal, criado_em) VALUES (?, ?, 1, ?)').run(uid, nome.split(/\s+/)[0].slice(0, 30), agora());
      return uid;
    });
    registrar(db, req, 'cadastro', { usuario_id: id, email });
    res.status(201).json(entrar(id));
  });

  r.post('/login', (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(req.body.email ?? '').trim());
    if (!u || !verificarSenha(String(req.body.senha ?? ''), u.senha_hash)) throw new ErroNegocio('E-mail ou senha incorretos.', 401);
    if (!u.ativo) throw new ErroNegocio('Conta desativada. Fale com o atendimento.', 403);
    res.json(entrar(u.id));
  });

  r.get('/me', autenticado, (req, res) => res.json(entrar(req.usuario.id)));

  r.patch('/me', autenticado, (req, res) => {
    const d = req.body;
    if (d.nome !== undefined) db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(v.texto(d.nome, 'o nome', 120), req.usuario.id);
    if (d.telefone !== undefined) {
      db.prepare('UPDATE usuarios SET telefone = ? WHERE id = ?').run(d.telefone ? v.telefone(d.telefone) : null, req.usuario.id);
    }
    if (d.email !== undefined) {
      const email = v.email(d.email);
      if (db.prepare('SELECT 1 FROM usuarios WHERE email = ? AND id <> ?').get(email, req.usuario.id)) throw new ErroNegocio('Já existe uma conta com este e-mail.', 409);
      db.prepare('UPDATE usuarios SET email = ? WHERE id = ?').run(email, req.usuario.id);
    }
    res.json({ usuario: publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuario.id)) });
  });

  r.post('/senha', autenticado, (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body.atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(req.body.nova)), req.usuario.id);
    registrar(db, req, 'senha_trocada');
    res.status(204).end();
  });

  return r;
};
