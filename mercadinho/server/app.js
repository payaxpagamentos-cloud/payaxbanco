'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');

// Tudo é servido pelo próprio servidor: nenhum script, fonte ou imagem vem de fora.
const CSP = [
  "default-src 'self'", "img-src 'self' data:", "style-src 'self' 'unsafe-inline'", "font-src 'self'",
  "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

function criarApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(), camera=(self), microphone=()',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': CSP,
    });
    next();
  });

  // Tudo é servido em MERCADO_BASE_PATH (ex.: /mercadinho): as páginas e a API em <endereço>/api.
  const r = express.Router();
  r.use(['/api/auth/login', '/api/terminal/parear'], limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // Tentativas de senha do morador no terminal: o limite por morador fica em lib/terminal.js.
  r.use('/api/terminal/venda', limitar({ janelaMs: 60_000, maximo: 120 }));
  r.use(express.json({ limit: '256kb' }));
  r.use('/api', criarApi(db));
  // "/pdv" sem a barra final leva a "/pdv/" (a tela do terminal usa caminhos relativos à pasta).
  // A rota casa com as duas formas, então só redireciona quando a barra realmente falta.
  r.get('/pdv', (req, res, next) => (req.originalUrl.split('?')[0].endsWith('/') ? next() : res.redirect(`${req.baseUrl}/pdv/`)));
  r.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.producao ? '1h' : 0 }));

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
