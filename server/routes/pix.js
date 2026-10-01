'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const v = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');
const { buscarConta, exigirContaOperavel } = require('../lib/conta');

const MAX_CHAVES = 5;

module.exports = (db) => {
  const r = Router();

  r.get('/', (req, res) => {
    const params = [];
    let where = '';
    if (req.query.q) { where = 'WHERE p.chave LIKE ? OR cl.nome LIKE ?'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    res.json(db.prepare(`SELECT p.*, c.agencia, c.numero, c.digito, cl.nome AS cliente_nome
      FROM chaves_pix p JOIN contas c ON c.id = p.conta_id JOIN clientes cl ON cl.id = c.cliente_id
      ${where} ORDER BY p.criado_em DESC LIMIT 500`).all(...params));
  });

  r.post('/', permitir('admin', 'gerente', 'operador'), (req, res) => {
    const conta = buscarConta(db, req.body?.conta_id);
    exigirContaOperavel(conta);
    const tipo = req.body?.tipo;
    v.exigir(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'].includes(tipo), 'Tipo de chave inválido.');
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM chaves_pix WHERE conta_id = ?').get(conta.id);
    if (total >= MAX_CHAVES) throw new ErroNegocio(`Limite de ${MAX_CHAVES} chaves por conta atingido.`, 409);

    let chave;
    if (tipo === 'cpf' || tipo === 'cnpj') {
      v.exigir(conta.cliente_documento.length === (tipo === 'cpf' ? 11 : 14), `O titular não possui ${tipo.toUpperCase()}.`);
      chave = conta.cliente_documento;
    } else if (tipo === 'email') {
      chave = String(req.body?.chave ?? '').trim().toLowerCase();
      v.exigir(v.emailValido(chave), 'E-mail inválido.');
    } else if (tipo === 'telefone') {
      chave = v.digitos(req.body?.chave);
      v.exigir(chave.length >= 10 && chave.length <= 11, 'Telefone deve ter DDD + número.');
    } else {
      chave = crypto.randomUUID();
    }
    if (db.prepare('SELECT 1 FROM chaves_pix WHERE chave = ?').get(chave)) throw new ErroNegocio('Chave PIX já cadastrada.', 409);
    const ins = db.prepare('INSERT INTO chaves_pix (conta_id, tipo, chave) VALUES (?, ?, ?)').run(conta.id, tipo, chave);
    registrar(db, req, 'criar', 'chave_pix', Number(ins.lastInsertRowid), { tipo, chave, conta_id: conta.id });
    res.status(201).json(db.prepare('SELECT * FROM chaves_pix WHERE id = ?').get(ins.lastInsertRowid));
  });

  r.delete('/:id', permitir('admin', 'gerente', 'operador'), (req, res) => {
    const chave = db.prepare('SELECT * FROM chaves_pix WHERE id = ?').get(req.params.id);
    if (!chave) throw naoEncontrado('Chave PIX');
    db.prepare('DELETE FROM chaves_pix WHERE id = ?').run(chave.id);
    registrar(db, req, 'excluir', 'chave_pix', chave.id, { chave: chave.chave });
    res.status(204).end();
  });

  return r;
};
