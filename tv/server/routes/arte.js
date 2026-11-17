'use strict';

const { Router } = require('express');
const { ErroNegocio } = require('../lib/erros');
const midia = require('../lib/midia');
const v = require('../lib/validacao');

/**
 * Artes do catálogo (capas, banners, logos e miniaturas). São públicas e cacheáveis:
 * é o que o navegador coloca em <img>, que não envia cabeçalho de autorização.
 * Vídeos e legendas, não: esses só saem com token de reprodução (routes/play.js).
 */
module.exports = (db) => {
  const r = Router();
  r.get('/:id', (req, res) => {
    const m = midia.buscar(db, v.inteiro(req.params.id, 'a imagem', { min: 1 }));
    if (m.tipo !== 'imagem' || m.status !== 'pronta') throw new ErroNegocio('Imagem não disponível.', 404);
    midia.enviar(req, res, m, { cache: 'public, max-age=2592000, immutable' });
  });
  return r;
};
