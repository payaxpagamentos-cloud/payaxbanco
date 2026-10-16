'use strict';

const { Router } = require('express');
const { permitir } = require('../auth');
const { hashSenha } = require('../lib/senha');
const { naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');
const { alcadaUsuario } = require('../lib/aprovacao');

const PERFIS = ['admin', 'supervisor', 'analista'];

module.exports = (db) => {
  const r = Router();

  // Lista resumida para escolher responsáveis (qualquer perfil).
  r.get('/equipe', (_req, res) => {
    res.json(db.prepare('SELECT id, nome, perfil FROM usuarios WHERE ativo = 1 ORDER BY nome').all());
  });

  r.get('/', permitir('admin'), (_req, res) => {
    res.json(db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.ativo, u.ultimo_acesso, u.criado_em,
      u.alcada_aprovacao_centavos, u.totp_ativo,
      (SELECT COUNT(*) FROM empresas e WHERE e.analista_id = u.id AND e.status IN ('ativa','implantacao')) AS empresas
      FROM usuarios u ORDER BY u.ativo DESC, u.nome`).all().map((u) => ({ ...u, alcada_efetiva_centavos: alcadaUsuario(u) })));
  });

  r.post('/', permitir('admin'), (req, res) => {
    const nome = v.texto(req.body.nome, 120);
    const email = v.texto(req.body.email, 120);
    const senha = String(req.body.senha ?? '');
    v.exigir(nome, 'Informe o nome.');
    v.exigir(v.emailValido(email), 'E-mail inválido.');
    v.exigir(PERFIS.includes(req.body.perfil), 'Perfil inválido.');
    v.exigir(senha.length >= 8, 'A senha deve ter pelo menos 8 caracteres.');
    const x = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)').run(nome, email, hashSenha(senha), req.body.perfil);
    registrar(db, req, 'usuario_criado', { id: Number(x.lastInsertRowid), email, perfil: req.body.perfil });
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });

  r.patch('/:id', permitir('admin'), (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
    if (!u) throw naoEncontrado('Usuário');
    const perfil = req.body.perfil ?? u.perfil;
    const ativo = req.body.ativo === undefined ? u.ativo : req.body.ativo ? 1 : 0;
    v.exigir(PERFIS.includes(perfil), 'Perfil inválido.');
    v.exigir(!(u.id === req.usuario.id && (perfil !== 'admin' || !ativo)), 'Você não pode rebaixar nem desativar o próprio usuário.');
    const nome = v.texto(req.body.nome, 120) ?? u.nome;
    let hash = u.senha_hash;
    if (req.body.senha) {
      v.exigir(String(req.body.senha).length >= 8, 'A senha deve ter pelo menos 8 caracteres.');
      hash = hashSenha(req.body.senha);
    }
    // Alçada de aprovação de pagamentos: vazio = padrão do perfil; -1 = sem limite; 0 = não aprova.
    let alcada = u.alcada_aprovacao_centavos;
    if ('alcada_aprovacao_centavos' in req.body) {
      alcada = req.body.alcada_aprovacao_centavos === null || req.body.alcada_aprovacao_centavos === '' ? null : Number(req.body.alcada_aprovacao_centavos);
      v.exigir(alcada === null || (Number.isInteger(alcada) && alcada >= -1), 'Alçada de aprovação inválida.');
    }
    db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ?, senha_hash = ?, alcada_aprovacao_centavos = ? WHERE id = ?').run(nome, perfil, ativo, hash, alcada, u.id);
    registrar(db, req, 'usuario_alterado', { id: u.id, perfil, ativo, senha_redefinida: Boolean(req.body.senha), alcada_aprovacao: [u.alcada_aprovacao_centavos, alcada] });
    res.status(204).end();
  });

  return r;
};
