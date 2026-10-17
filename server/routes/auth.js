'use strict';

const { Router } = require('express');
const { emitirToken, emitirDesafio2fa, lerToken } = require('../auth');
const { verificarSenha, hashSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { alcadaUsuario } = require('../lib/aprovacao');
const dois = require('../lib/doisfatores');
const v = require('../lib/validacao');

// Hash de referência: usuários inexistentes gastam o mesmo tempo que senhas erradas.
const HASH_FALSO = hashSenha('senha-inexistente');
const publico = (u) => ({ id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, totp_ativo: Boolean(u.totp_ativo), alcada_aprovacao_centavos: alcadaUsuario(u) });

module.exports = (db, auth) => {
  const r = Router();

  /** Senha correta: entra direto, ou recebe um desafio para o código do aplicativo (2FA ativa). */
  r.post('/login', (req, res) => {
    const email = v.texto(req.body.email, 120);
    const senha = String(req.body.senha ?? '');
    const u = email && db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
    const ok = verificarSenha(senha, u?.senha_hash ?? HASH_FALSO);
    if (!u || !ok || !u.ativo) {
      registrar(db, req, 'login_falhou', { email });
      throw new ErroNegocio(u && ok && !u.ativo ? 'Usuário inativo.' : 'E-mail ou senha incorretos.', 401);
    }
    if (u.totp_ativo) return res.json({ precisa_2fa: true, desafio: emitirDesafio2fa(u.id, 'bpo') });
    entrar(req, res, u);
  });

  r.post('/2fa/login', (req, res) => {
    const d = lerToken(req.body.desafio, '2fa-bpo');
    if (!d) throw new ErroNegocio('Tempo esgotado. Entre com a senha novamente.', 401);
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND ativo = 1').get(d.sub);
    if (!u || !dois.conferir(db, 'usuarios', u.id, req.body.codigo)) {
      registrar(db, { ...req, usuario: u }, 'login_2fa_falhou');
      throw new ErroNegocio('Código inválido.', 401);
    }
    entrar(req, res, u);
  });

  function entrar(req, res, u) {
    db.prepare("UPDATE usuarios SET ultimo_acesso = datetime('now') WHERE id = ?").run(u.id);
    registrar(db, { ...req, usuario: u }, 'login');
    // 2FA obrigatória e ainda não configurada: sessão restrita à configuração.
    const configurar = dois.exigidaEquipe(db) && !u.totp_ativo;
    res.json({ token: emitirToken(u, configurar ? { cfg2fa: true } : {}), usuario: publico(u), configurar_2fa: configurar });
  }

  r.get('/me', auth, (req, res) => res.json({ usuario: publico(req.usuario), exigir_2fa: dois.exigidaEquipe(db) }));

  r.post('/senha', auth, (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body.senha_atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    const nova = String(req.body.nova_senha ?? '');
    v.exigir(nova.length >= 8, 'A nova senha deve ter pelo menos 8 caracteres.');
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(nova), req.usuario.id);
    registrar(db, req, 'senha_alterada');
    res.status(204).end();
  });

  r.post('/2fa/iniciar', auth, async (req, res) => res.json(await dois.iniciar(db, 'usuarios', req.usuario, req.usuario.email)));
  r.post('/2fa/ativar', auth, (req, res) => {
    dois.ativar(db, 'usuarios', req.usuario, req.body.codigo);
    registrar(db, req, '2fa_ativada');
    // Nova sessão completa (a anterior podia estar restrita à configuração).
    res.json({ token: emitirToken(req.usuario) });
  });
  r.post('/2fa/desativar', auth, (req, res) => {
    v.exigir(!dois.exigidaEquipe(db), 'A autenticação em duas etapas é obrigatória para a equipe.');
    dois.desativar(db, 'usuarios', req.usuario.id, req.body.senha, req.body.codigo);
    registrar(db, req, '2fa_desativada');
    res.status(204).end();
  });

  return r;
};
