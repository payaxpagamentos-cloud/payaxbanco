'use strict';

const express = require('express');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { exigir } = require('../auth');
const { listaPaginada } = require('../lib/http');
const { hashSenha } = require('../lib/senha');
const v = require('../lib/validacao');
const auditoria = require('../lib/auditoria');

const PERFIS = ['admin', 'financeiro', 'operacao', 'consulta'];

module.exports = (db) => {
  const r = express.Router();

  r.get('/usuarios', exigir('*'), (_req, res) => {
    res.json(db.prepare('SELECT id, nome, email, perfil, ativo, senha_provisoria, ultimo_acesso, criado_em FROM usuarios ORDER BY nome').all());
  });

  r.post('/usuarios', exigir('*'), (req, res) => {
    const nome = v.texto(req.body?.nome, 'o nome', 120);
    const email = v.email(req.body?.email);
    const perfil = v.opcao(req.body?.perfil, 'o perfil', PERFIS);
    const senha = v.senha(req.body?.senha);
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe um usuário com este e-mail.', 409);
    const id = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, senha_provisoria, criado_em) VALUES (?, ?, ?, ?, 1, ?) RETURNING id')
      .get(nome, email, hashSenha(senha), perfil, agora()).id;
    auditoria.registrar(db, req, { acao: 'usuario.criado', entidade: 'usuario', entidade_id: id, depois: { nome, email, perfil } });
    res.status(201).json({ id, nome, email, perfil });
  });

  r.patch('/usuarios/:id', exigir('*'), (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
    if (!u) throw naoEncontrado('Usuário');
    const d = {};
    if (req.body?.nome !== undefined) d.nome = v.texto(req.body.nome, 'o nome', 120);
    if (req.body?.perfil !== undefined) d.perfil = v.opcao(req.body.perfil, 'o perfil', PERFIS);
    if (req.body?.ativo !== undefined) d.ativo = v.booleano(req.body.ativo) ? 1 : 0;
    if (req.body?.senha) { d.senha_hash = hashSenha(v.senha(req.body.senha)); d.senha_provisoria = 1; }
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    // Sempre sobra pelo menos um administrador ativo.
    if ((d.ativo === 0 || (d.perfil && d.perfil !== 'admin')) && u.perfil === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'admin' AND ativo = 1 AND id <> ?").get(u.id).n;
      if (!admins) throw new ErroNegocio('É preciso manter ao menos um administrador ativo.', 409);
    }
    const campos = Object.keys(d);
    db.prepare(`UPDATE usuarios SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...campos.map((k) => d[k]), u.id);
    auditoria.registrar(db, req, { acao: 'usuario.alterado', entidade: 'usuario', entidade_id: u.id, depois: { ...d, senha_hash: undefined } });
    res.json({ id: u.id, ...d, senha_hash: undefined });
  });

  r.get('/auditoria', exigir('auditoria.ver'), (req, res) => {
    const cond = [];
    const p = [];
    if (req.query.cliente_id) { cond.push('a.cliente_id = ?'); p.push(Number(req.query.cliente_id)); }
    if (req.query.acao) { cond.push('a.acao LIKE ?'); p.push(`${req.query.acao}%`); }
    if (req.query.de) { cond.push('date(a.criado_em) >= ?'); p.push(req.query.de); }
    if (req.query.ate) { cond.push('date(a.criado_em) <= ?'); p.push(req.query.ate); }
    const sql = `SELECT a.*, c.razao_social FROM auditoria a LEFT JOIN clientes c ON c.id = a.cliente_id
      ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY a.id DESC`;
    res.json(listaPaginada(db, sql, p, req.query, { padrao: 100, maximo: 500 }));
  });

  return r;
};
