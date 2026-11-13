'use strict';

const express = require('express');
const { agora } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { emitirToken, sessaoEquipe } = require('../auth');
const v = require('../lib/validacao');
const auditoria = require('../lib/auditoria');

module.exports = (db, autenticado) => {
  const r = express.Router();

  r.post('/login', (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
    // Mensagem igual para e-mail inexistente e senha errada: não revela quem tem acesso.
    if (!u || !u.ativo || !verificarSenha(String(req.body?.senha ?? ''), u.senha_hash)) {
      throw new ErroNegocio('E-mail ou senha inválidos.', 401);
    }
    db.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora(), u.id);
    auditoria.registrar(db, { ...req, usuario: u, usuarioTipo: 'equipe' }, { acao: 'login', entidade: 'usuario', entidade_id: u.id });
    res.json({ token: emitirToken(u.id, 'payax'), usuario: sessaoEquipe(u) });
  });

  r.get('/eu', autenticado, (req, res) => res.json({ usuario: sessaoEquipe(req.usuario) }));

  r.post('/senha', autenticado, (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body?.senha_atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 401);
    const nova = v.senha(req.body?.senha_nova);
    if (nova === String(req.body?.senha_atual)) throw new ErroNegocio('A nova senha precisa ser diferente da atual.', 422);
    db.prepare('UPDATE usuarios SET senha_hash = ?, senha_provisoria = 0 WHERE id = ?').run(hashSenha(nova), u.id);
    auditoria.registrar(db, req, { acao: 'senha.trocada', entidade: 'usuario', entidade_id: u.id });
    res.json({ ok: true });
  });

  return r;
};
