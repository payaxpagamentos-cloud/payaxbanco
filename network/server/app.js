'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');
const { requestId } = require('./lib/http');

/** Origem da camada de imagens do mapa, liberada na política de segurança. */
const origemTiles = (() => {
  try { return new URL(config.mapa.tiles.replace(/\{s\}/, 'a').replace(/\{[^}]+\}/g, '0')).origin.replace('://a.', '://*.'); } catch { return ''; }
})();
const CSP = [`default-src 'self'`, `img-src 'self' data: blob: ${origemTiles}`, `style-src 'self' 'unsafe-inline'`, `font-src 'self'`,
  `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'`].join('; ');

function criarApp(db, extras = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use(requestId);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': CSP,
    });
    next();
  });
  const r = express.Router();
  r.use('/api/auth/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // Arquivos chegam como corpo bruto, lido só depois da autenticação (em api.js); o resto, JSON.
  const json = express.json({ limit: '1mb' });
  r.use((req, res, next) => (/^\/api\/anexos(\/|$)/.test(req.path) ? next() : json(req, res, next)));
  r.use('/api', criarApi(db, extras));
  r.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js')), { maxAge: '7d' }));
  r.use('/vendor/markercluster', express.static(path.dirname(require.resolve('leaflet.markercluster/dist/leaflet.markercluster.js')), { maxAge: '7d' }));
  r.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  if (config.basePath) {
    app.get(config.basePath, (req, res, next) => (req.originalUrl.split('?')[0] === config.basePath ? res.redirect(`${config.basePath}/`) : next()));
    app.get('/', (_req, res) => res.redirect(`${config.basePath}/`));
  }
  app.use(config.basePath || '/', r);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => tratarErro(err, req, res));
  return app;
}

module.exports = { criarApp };
