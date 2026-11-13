'use strict';

const express = require('express');
const { agora } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { emitirToken, emitirDesafio, lerDesafio, sessaoEquipe } = require('../auth');
const v = require('../lib/validacao');
const auditoria = require('../lib/auditoria');
const dois = require('../lib/doisfatores');

module.exports = (db, autenticado) => {
  const r = express.Router();

  const entrar = (req, res, u) => {
    db.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora(), u.id);
    auditoria.registrar(db, { ...req, usuario: u, usuarioTipo: 'equipe' }, { acao: 'login', entidade: 'usuario', entidade_id: u.id });
    res.json({
      token: emitirToken(u.id, 'payax'),
      usuario: sessaoEquipe(u),
      // Com a exigência ligada, quem ainda não tem 2FA precisa configurar antes de trabalhar.
      configurar_2fa: dois.exigidaEquipe(db) && !u.totp_ativo,
    });
  };

  r.post('/login', (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
    // Mensagem igual para e-mail inexistente e senha errada: não revela quem tem acesso.
    if (!u || !u.ativo || !verificarSenha(String(req.body?.senha ?? ''), u.senha_hash)) {
      auditoria.registrar(db, req, { acao: 'login.recusado', entidade: 'usuario', entidade_id: u?.id ?? null, depois: { email } });
      throw new ErroNegocio('E-mail ou senha inválidos.', 401);
    }
    if (u.totp_ativo) {
      // Segunda etapa: o desafio vale 5 minutos e só serve para informar o código.
      return res.json({ precisa_2fa: true, desafio: emitirDesafio(u.id, 'equipe') });
    }
    return entrar(req, res, u);
  });

  /** Segunda etapa do login. */
  r.post('/2fa', (req, res) => {
    const d = lerDesafio(req.body?.desafio, 'equipe');
    if (!d) throw new ErroNegocio('A verificação expirou. Entre de novo.', 401);
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(d.sub);
    if (!u || !u.ativo) throw new ErroNegocio('Usuário inativo.', 401);
    if (!dois.conferir(db, 'equipe', u.id, req.body?.codigo)) {
      auditoria.registrar(db, { ...req, usuario: u, usuarioTipo: 'equipe' }, { acao: 'login.2fa.recusado', entidade: 'usuario', entidade_id: u.id });
      throw new ErroNegocio('Código inválido. Confira o horário do celular e tente de novo.', 401);
    }
    return entrar(req, res, u);
  });

  r.get('/eu', autenticado, (req, res) => res.json({
    usuario: sessaoEquipe(req.usuario),
    configurar_2fa: dois.exigidaEquipe(db) && !req.usuario.totp_ativo,
  }));

  r.post('/senha', autenticado, (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body?.senha_atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 401);
    const nova = v.senha(req.body?.senha_nova);
    if (nova === String(req.body?.senha_atual)) throw new ErroNegocio('A nova senha precisa ser diferente da atual.', 422);
    db.prepare('UPDATE usuarios SET senha_hash = ?, senha_provisoria = 0 WHERE id = ?').run(hashSenha(nova), u.id);
    auditoria.registrar(db, req, { acao: 'senha.trocada', entidade: 'usuario', entidade_id: u.id });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- Configuração do 2FA
  r.post('/2fa/iniciar', autenticado, async (req, res) => {
    res.json(await dois.iniciar(db, 'equipe', req.usuario, req.usuario.email));
  });

  r.post('/2fa/ativar', autenticado, (req, res) => {
    dois.ativar(db, 'equipe', req.usuario, req.body?.codigo);
    auditoria.registrar(db, req, { acao: '2fa.ativada', entidade: 'usuario', entidade_id: req.usuario.id });
    res.json({ ok: true });
  });

  r.post('/2fa/desativar', autenticado, (req, res) => {
    if (dois.exigidaEquipe(db)) throw new ErroNegocio('A autenticação em duas etapas é obrigatória para a equipe e não pode ser desligada.', 403);
    dois.desativar(db, 'equipe', req.usuario.id, req.body?.senha, req.body?.codigo);
    auditoria.registrar(db, req, { acao: '2fa.desativada', entidade: 'usuario', entidade_id: req.usuario.id });
    res.json({ ok: true });
  });

  return r;
};
