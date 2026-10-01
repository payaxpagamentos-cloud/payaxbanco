'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const config = require('../config');
const { ErroNegocio } = require('../lib/erros');

/*
 * Webhook PIX chamado pelo Bradesco (padrão do Banco Central: POST {url}/pix com { pix: [...] }).
 * Protegido por token na URL cadastrada (?token=...). Em produção, restrinja também por mTLS no proxy.
 */
module.exports = (_db, bradesco) => {
  const r = Router();
  const igual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  function verificar(req) {
    const esperado = config.bradesco.webhookToken;
    if (!esperado) {
      if (bradesco.status().modo !== 'simulador') throw new ErroNegocio('Webhook não configurado (defina BRADESCO_WEBHOOK_TOKEN).', 503);
      return;
    }
    const recebido = req.query.token || req.get('x-webhook-token') || '';
    if (!igual(recebido, esperado)) throw new ErroNegocio('Token do webhook inválido.', 401);
  }

  const receber = (req, res) => {
    verificar(req);
    if (!Array.isArray(req.body?.pix)) throw new ErroNegocio('Corpo do webhook inválido: esperado { pix: [...] }.', 400);
    res.json(bradesco.processarRecebidos(req.body.pix, { usuario: null, ip: req.ip ?? 'bradesco' }));
  };
  r.post('/pix', receber);
  r.post('/', receber);
  return r;
};
