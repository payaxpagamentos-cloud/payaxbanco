'use strict';

const { Router } = require('express');
const integ = require('../lib/integracoes');
const lanc = require('../lib/lancamentos');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');

/**
 * API de integração (v1) para sistemas de gestão da empresa cliente. Autenticação por chave de API
 * (Authorization: Bearer bpo_…), que vale só para a empresa dela.
 */
module.exports = (db) => {
  const r = Router();
  r.use(integ.autenticarChave(db));
  const eid = (req) => req.empresa.id;
  const quem = (req) => ({ ip: req.ip });

  r.get('/empresa', (req, res) => res.json({
    id: req.empresa.id, razao_social: req.empresa.razao_social, cnpj: req.empresa.cnpj,
    contas: lanc.saldos(db, eid(req)).filter((c) => c.ativo).map((c) => ({ id: c.id, descricao: c.descricao, banco: c.banco, saldo_centavos: c.saldo_centavos })),
  }));
  r.get('/categorias', (req, res) => res.json(db.prepare('SELECT id, nome, tipo FROM categorias WHERE empresa_id = ? AND ativo = 1 ORDER BY tipo, nome').all(eid(req))));
  r.get('/lancamentos', (req, res) => {
    const desde = req.query.desde && v.data(req.query.desde, 'a data');
    res.json(db.prepare(`SELECT id, tipo, descricao, valor_centavos, competencia, vencimento, documento, status, pago_em, valor_pago_centavos, aprovacao
      FROM lancamentos WHERE empresa_id = ? AND (? IS NULL OR vencimento >= ?) ORDER BY id DESC LIMIT 1000`).all(eid(req), desde ?? null, desde ?? null));
  });
  /** Um lançamento ou { lancamentos: [...] }. Categoria por id ou nome; contato por id, CPF/CNPJ ou nome. */
  r.post('/lancamentos', (req, res) => {
    const itens = Array.isArray(req.body.lancamentos) ? req.body.lancamentos : [req.body];
    const ids = integ.criarEmLote(db, quem(req), eid(req), itens);
    registrar(db, quem(req), 'api_lancamentos_criados', { chave: req.chaveApi.prefixo, ids }, eid(req));
    res.status(201).json({ ids });
  });
  return r;
};
