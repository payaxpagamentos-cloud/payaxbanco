'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const { Router } = require('express');
const { agora } = require('../db');
const { emitirToken } = require('../auth');
const { hashSenha, verificarSenha, gastarTempo } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');

const publico = (u) => ({ id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, empresa_id: u.empresa_id, empresa_nome: u.empresa_nome ?? null,
  acesso: u.acesso ?? 'completo' });

/** Login e a própria conta. Não há cadastro aberto: os usuários são criados pelo master ou pelo administrador da empresa. */
module.exports = (db, autenticado) => {
  const r = Router();

  r.post('/login', (req, res) => {
    const u = db.prepare(`SELECT u.*, e.nome AS empresa_nome, e.status AS empresa_status FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id
      WHERE u.email = ?`).get(String(req.body.email ?? '').trim());
    if (!u) gastarTempo(String(req.body.senha ?? ''));
    if (!u || !verificarSenha(String(req.body.senha ?? ''), u.senha_hash)) {
      registrar(db, req, 'login_falhou', { email: String(req.body.email ?? '').slice(0, 160) }, u?.empresa_id ?? null);
      throw new ErroNegocio('E-mail ou senha incorretos.', 401);
    }
    if (!u.ativo) throw new ErroNegocio('Usuário desativado. Fale com o administrador.', 403);
    if (u.empresa_id && u.empresa_status !== 'ativa') throw new ErroNegocio('Empresa bloqueada. Fale com o suporte.', 403);
    db.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora(), u.id);
    registrar(db, { usuario: u, ip: req.ip }, 'login', undefined, u.empresa_id);
    res.json({ token: emitirToken(u), usuario: publico(u) });
  });

  r.get('/me', autenticado, (req, res) => res.json({ usuario: publico(req.usuario) }));

  r.post('/senha', autenticado, (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body.atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    const novo = hashSenha(v.senha(req.body.nova));
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(novo, req.usuario.id);
    registrar(db, req, 'senha_alterada', undefined, req.usuario.empresa_id);
    // As sessões antigas caem com a troca; quem trocou recebe um token novo e continua logado.
    res.json({ token: emitirToken({ id: req.usuario.id, senha_hash: novo }) });
  });

  return r;
};
