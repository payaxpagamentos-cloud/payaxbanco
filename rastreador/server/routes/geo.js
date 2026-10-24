'use strict';

const { Router } = require('express');
const { ErroNegocio } = require('../lib/erros');
const geo = require('../lib/geocodificacao');
const v = require('../lib/validacao');

/** Busca de endereços (campo de busca do mapa) e o endereço de um ponto (painel do veículo). Só para quem está logado. */
module.exports = () => {
  const r = Router();
  const falhou = (err) => {
    console.error('[Rastreador] Busca de endereços:', err.message);
    return new ErroNegocio('Busca de endereços indisponível no momento. Tente de novo em instantes.', 503);
  };

  r.get('/buscar', async (req, res, next) => {
    try {
      const perto = req.query.lat && req.query.lng ? (([lat, lng]) => ({ lat, lng }))(v.coordenadas(req.query.lat, req.query.lng)) : null;
      res.json(await geo.buscar(req.query.q, perto));
    } catch (err) {
      next(err instanceof ErroNegocio ? err : falhou(err));
    }
  });

  r.get('/endereco', async (req, res, next) => {
    try {
      const [lat, lng] = v.coordenadas(req.query.lat, req.query.lng);
      res.set('Cache-Control', 'private, max-age=600').json(await geo.endereco(lat, lng));
    } catch (err) {
      next(err instanceof ErroNegocio ? err : falhou(err));
    }
  });

  return r;
};
