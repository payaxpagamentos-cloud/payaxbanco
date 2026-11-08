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

/**
 * Política de segurança das páginas. Com o Google Maps, libera os domínios que a API JavaScript do Google exige
 * (lista da documentação do Google Maps para CSP); com o OpenStreetMap, só o servidor de mapas.
 */
const csp = config.mapa.provedor === 'google'
  ? ["default-src 'self'", "script-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com 'unsafe-eval' blob:",
    "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://*.googleapis.com https://*.google.com https://*.gstatic.com data: blob:", 'worker-src blob:',
    'frame-src https://*.google.com', "frame-ancestors 'none'"].join('; ')
  : `default-src 'self'; img-src 'self' data: ${origemTiles}; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`;

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
      'Content-Security-Policy': csp,
    });
    next();
  });
  // Tudo é servido em TAXI_BASE_PATH (ex.: /taxi): páginas, arquivos e a API em <endereço>/api.
  const r = express.Router();
  r.use(['/api/auth/login', '/api/auth/cadastro', '/api/auth/cadastro-motorista'], limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  r.use(express.json({ limit: '100kb' }));
  r.use('/api', criarApi(db));

  const publico = path.join(__dirname, '..', 'public');
  // Leaflet (mapa) servido do próprio pacote, sem CDN.
  r.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js')), { maxAge: '7d' }));
  // "/passageiro" sem a barra final leva a "/passageiro/" (as páginas usam caminhos relativos à pasta).
  r.get(/^\/(passageiro|motorista|central)$/, (req, res) => res.redirect(`${req.baseUrl}${req.path}/`));
  r.use(express.static(publico));
  if (config.basePath) {
    app.get(['/', config.basePath], (req, res, next) => (req.originalUrl.split('?')[0] === '/' || req.originalUrl.split('?')[0] === config.basePath
      ? res.redirect(`${config.basePath}/`) : next()));
  }
  app.use(config.basePath || '/', r);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => tratarErro(err, res));
  return app;
}

module.exports = { criarApp };
