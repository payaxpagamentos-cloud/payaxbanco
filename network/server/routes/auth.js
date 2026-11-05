'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { emitirToken } = require('../auth');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { permissoesDo, PERFIS } = require('../lib/permissoes');
const v = require('../lib/validacao');

const publico = (u) => ({
  id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, perfil_nome: PERFIS[u.perfil], organizacao_id: u.organizacao_id,
  organizacao_nome: u.organizacao_nome, fuso: u.fuso, demonstracao: Boolean(u.demonstracao), tecnico_id: u.tecnico_id ?? null,
  permissoes: permissoesDo(u.perfil),
});

module.exports = (db, autenticado) => {
  const r = Router();
  const buscar = db.prepare(`SELECT u.*, o.nome AS organizacao_nome, o.fuso, o.demonstracao, t.id AS tecnico_id FROM usuarios u
    JOIN organizacoes o ON o.id = u.organizacao_id LEFT JOIN tecnicos t ON t.usuario_id = u.id WHERE u.email = ?`);

  r.post('/login', (req, res) => {
    const email = String(req.body?.email ?? '').trim();
    const u = buscar.get(email);
    if (!u || !verificarSenha(String(req.body?.senha ?? ''), u.senha_hash)) {
      registrar(db, req, 'login_falhou', { depois: { email: email.slice(0, 160) }, organizacaoId: u?.organizacao_id ?? null });
      throw new ErroNegocio('E-mail ou senha incorretos.', 401);
    }
    if (!u.ativo) throw new ErroNegocio('Usuário desativado. Fale com o administrador.', 403);
    db.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora(), u.id);
    registrar(db, { usuario: u, ip: req.ip, requestId: req.requestId }, 'login', { recurso: 'usuario', recursoId: u.id });
    res.json({ token: emitirToken(u), usuario: publico(u) });
  });

  r.get('/me', autenticado, (req, res) => res.json({ usuario: publico(req.usuario) }));

  r.post('/senha', autenticado, (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body?.atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(req.body.nova)), req.usuario.id);
    registrar(db, req, 'senha_alterada', { recurso: 'usuario', recursoId: req.usuario.id });
    res.status(204).end();
  });

  return r;
};
