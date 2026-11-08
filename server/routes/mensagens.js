'use strict';

const { Router } = require('express');
const v = require('../lib/validacao');

/** Conversa com o cliente. Lado da equipe (o Portal tem a rota própria). */
function listar(db, empresaId, lado) {
  const outro = lado === 'equipe' ? 'cliente' : 'equipe';
  db.prepare("UPDATE mensagens SET lida_em = datetime('now') WHERE empresa_id = ? AND autor = ? AND lida_em IS NULL").run(empresaId, outro);
  return db.prepare(`SELECT m.id, m.autor, m.texto, m.lida_em, m.criado_em, COALESCE(u.nome, r.nome) AS autor_nome FROM mensagens m
    LEFT JOIN usuarios u ON u.id = m.usuario_id LEFT JOIN responsaveis r ON r.id = m.responsavel_id
    WHERE m.empresa_id = ? ORDER BY m.id DESC LIMIT 200`).all(empresaId).reverse();
}

function enviar(db, empresaId, lado, autorId, texto) {
  const t = v.texto(texto, 4000);
  v.exigir(t, 'Escreva a mensagem.');
  const r = db.prepare('INSERT INTO mensagens (empresa_id, autor, usuario_id, responsavel_id, texto) VALUES (?, ?, ?, ?, ?)')
    .run(empresaId, lado, lado === 'equipe' ? autorId : null, lado === 'cliente' ? autorId : null, t);
  return Number(r.lastInsertRowid);
}

function rotas(db) {
  const r = Router();
  r.get('/', (req, res) => res.json(listar(db, req.empresa.id, 'equipe')));
  r.post('/', (req, res) => res.status(201).json({ id: enviar(db, req.empresa.id, 'equipe', req.usuario.id, req.body.texto) }));
  return r;
}

module.exports = Object.assign(rotas, { listar, enviar });
