'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');

// media-src/blob: o player guarda vídeos e imagens em cache para rodar sem internet.
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; "
  + "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";

function criarApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': CSP,
    });
    next();
  });
  // Tudo é servido em MIDIA_BASE_PATH (ex.: /midia): o painel, a API em <endereço>/api e o player das TVs em <endereço>/tv/.
  const r = express.Router();
  r.use('/api/auth/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // O envio de mídia tem o corpo bruto (arquivo) e limite próprio; o resto é JSON de até 400 kB.
  // O envio de criativo vai no corpo bruto (arquivo) com limite próprio; o resto é JSON de até 400 kB.
  r.use('/api', (req, res, next) => (req.method === 'POST' && /^\/(painel|anunciante|ponto)\/midias$/.test(req.path)
    ? express.raw({ type: '*/*', limit: config.midiaMaxBytes })(req, res, next)
    : express.json({ limit: '400kb' })(req, res, next)));
  r.use('/api', criarApi(db));
  r.use(express.static(path.join(__dirname, '..', 'public')));
  if (config.basePath) {
    app.get(config.basePath, (req, res, next) => (req.originalUrl.split('?')[0] === config.basePath ? res.redirect(`${config.basePath}/`) : next()));
    app.get('/', (_req, res) => res.redirect(`${config.basePath}/`));
  }
  app.use(config.basePath || '/', r);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => tratarErro(err, res));
  return app;
}

module.exports = { criarApp };
