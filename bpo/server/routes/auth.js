'use strict';

const { Router } = require('express');
const { emitirToken } = require('../auth');
const { verificarSenha, hashSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');

// Hash de referência: usuários inexistentes gastam o mesmo tempo que senhas erradas.
const HASH_FALSO = hashSenha('senha-inexistente');

module.exports = (db, auth) => {
  const r = Router();

  r.post('/login', (req, res) => {
    const email = v.texto(req.body.email, 120);
    const senha = String(req.body.senha ?? '');
    const u = email && db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
    const ok = verificarSenha(senha, u?.senha_hash ?? HASH_FALSO);
    if (!u || !ok || !u.ativo) {
      registrar(db, req, 'login_falhou', { email });
      throw new ErroNegocio(u && ok && !u.ativo ? 'Usuário inativo.' : 'E-mail ou senha incorretos.', 401);
    }
    db.prepare("UPDATE usuarios SET ultimo_acesso = datetime('now') WHERE id = ?").run(u.id);
    registrar(db, { ...req, usuario: u }, 'login');
    res.json({ token: emitirToken(u), usuario: { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil } });
  });

  r.get('/me', auth, (req, res) => res.json({ usuario: req.usuario }));

  r.post('/senha', auth, (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body.senha_atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    const nova = String(req.body.nova_senha ?? '');
    v.exigir(nova.length >= 8, 'A nova senha deve ter pelo menos 8 caracteres.');
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(nova), req.usuario.id);
    registrar(db, req, 'senha_alterada');
    res.status(204).end();
  });

  return r;
};
