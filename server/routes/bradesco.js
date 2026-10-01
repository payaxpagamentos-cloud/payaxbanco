'use strict';

const { Router } = require('express');
const { alcada } = require('../lib/alcadas');
const { permitir } = require('../auth');
const v = require('../lib/validacao');

module.exports = (db, bradesco) => {
  const r = Router();
  const gestores = alcada(db, 'bradesco.conciliar');

  r.get('/status', (_req, res) => res.json(bradesco.status()));

  r.get('/cobrancas', (req, res) => {
    const filtros = [];
    const params = [];
    if (req.query.conta_id) { filtros.push('p.conta_id = ?'); params.push(req.query.conta_id); }
    if (req.query.status) { filtros.push('p.status = ?'); params.push(req.query.status); }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT p.id, p.txid, p.conta_id, p.valor_centavos, p.status, p.expira_em, p.pago_em, p.criado_em,
        c.numero || '-' || c.digito AS conta, cl.nome AS cliente_nome
      FROM cobrancas_pix p JOIN contas c ON c.id = p.conta_id JOIN clientes cl ON cl.id = c.cliente_id
      ${where} ORDER BY p.id DESC LIMIT 100`).all(...params));
  });

  r.post('/cobrancas', alcada(db, 'bradesco.cobrancas'), async (req, res) => {
    res.status(201).json(await bradesco.gerarCobranca(req, req.body?.conta_id, req.body?.valor_centavos));
  });

  r.get('/cobrancas/:txid', async (req, res) => res.json(await bradesco.detalharCobranca(req.params.txid)));

  r.post('/cobrancas/:txid/simular-pagamento', (req, res) => res.json(bradesco.simularPagamento(req, req.params.txid)));

  r.post('/simular-pix-avulso', gestores, (req, res) => res.json(bradesco.simularPixAvulso(req, req.body?.valor_centavos)));

  r.post('/sincronizar', gestores, async (req, res) => res.json(await bradesco.sincronizar(req)));

  r.get('/conciliacao', gestores, async (_req, res) => res.json(await bradesco.conciliacao()));

  r.post('/recebidos/:id/vincular', gestores, (req, res) => {
    v.exigir(req.body?.conta_id, 'Selecione a conta.');
    res.json(bradesco.vincular(req, req.params.id, req.body.conta_id));
  });

  r.post('/configurar-webhook', permitir('admin'), async (req, res) => res.json(await bradesco.configurarWebhook(req, req.body?.url)));

  return r;
};
