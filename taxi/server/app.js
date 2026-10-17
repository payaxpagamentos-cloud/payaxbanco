'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');

/** Origem da camada de mapa (ex.: https://tile.openstreetmap.org), liberada na política de segurança. */
const origemTiles = (() => {
  try {
    return new URL(config.mapa.tiles.replace(/\{s\}/, 'a').replace(/\{[^}]+\}/g, '0')).origin.replace('://a.', '://*.');
  } catch {
    return '';
  }
})();

function criarApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': `default-src 'self'; img-src 'self' data: ${origemTiles}; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
    });
    next();
  });
  app.use(['/api/auth/login', '/api/auth/cadastro', '/api/auth/cadastro-motorista'], limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', criarApi(db));

  const publico = path.join(__dirname, '..', 'public');
  // Leaflet (mapa) servido do próprio pacote, sem CDN.
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js')), { maxAge: '7d' }));
  // "/passageiro" sem a barra final leva a "/passageiro/" (as páginas usam caminhos relativos à pasta).
  app.get(/^\/(passageiro|motorista|central)$/, (req, res) => res.redirect(`${req.path}/`));
  app.use(express.static(publico));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => tratarErro(err, res));
  return app;
}

module.exports = { criarApp };
