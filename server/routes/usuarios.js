'use strict';

const { Router } = require('express');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const v = require('../lib/validacao');
const { hashSenha } = require('../lib/senha');
const { registrar } = require('../lib/auditoria');

const PERFIS = ['admin', 'gerente', 'operador', 'ouvidoria', 'antifraude'];
const COLS = 'id, nome, email, perfil, ativo, ultimo_acesso, criado_em';

module.exports = (db) => {
  const r = Router();

  r.get('/', (_req, res) => res.json(db.prepare(`SELECT ${COLS} FROM usuarios ORDER BY nome`).all()));

  r.post('/', (req, res) => {
    const { nome, email, senha, perfil } = req.body ?? {};
    v.exigir(v.texto(nome) && nome.trim().length >= 3, 'Informe o nome.');
    v.exigir(v.emailValido(email), 'E-mail inválido.');
    v.exigir(PERFIS.includes(perfil), 'Perfil inválido.');
    v.exigir(typeof senha === 'string' && senha.length >= 8, 'A senha deve ter pelo menos 8 caracteres.');
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email.trim())) throw new ErroNegocio('E-mail já cadastrado.', 409);
    const ins = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)')
      .run(nome.trim(), email.trim().toLowerCase(), hashSenha(senha), perfil);
    registrar(db, req, 'criar', 'usuario', Number(ins.lastInsertRowid), { email, perfil });
    res.status(201).json(db.prepare(`SELECT ${COLS} FROM usuarios WHERE id = ?`).get(ins.lastInsertRowid));
  });

  r.put('/:id', (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
    if (!u) throw naoEncontrado('Usuário');
    const nome = v.texto(req.body?.nome) ?? u.nome;
    const perfil = req.body?.perfil ?? u.perfil;
    const ativo = req.body?.ativo === undefined ? u.ativo : (req.body.ativo ? 1 : 0);
    v.exigir(PERFIS.includes(perfil), 'Perfil inválido.');
    if (u.id === req.usuario.id && (perfil !== 'admin' || !ativo)) {
      throw new ErroNegocio('Você não pode remover seu próprio acesso de administrador.', 409);
    }
    db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ? WHERE id = ?').run(nome, perfil, ativo, u.id);
    if (req.body?.senha) {
      v.exigir(String(req.body.senha).length >= 8, 'A senha deve ter pelo menos 8 caracteres.');
      db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(req.body.senha), u.id);
    }
    registrar(db, req, 'atualizar', 'usuario', u.id, { nome, perfil, ativo, senha_redefinida: Boolean(req.body?.senha) });
    res.json(db.prepare(`SELECT ${COLS} FROM usuarios WHERE id = ?`).get(u.id));
  });

  return r;
};
