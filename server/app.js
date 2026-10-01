'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');

function criarApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use(express.json({ limit: '100kb' }));

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  // Freia tentativas de senha por IP (complementa o bloqueio por conta).
  app.use(['/api/auth/login', '/api/ib/auth/login'], limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  app.use('/api/ib/abertura', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  app.use('/api/ib/auth/teclado', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto * 3 }));
  app.use('/api', criarApi(db));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => tratarErro(err, res));

  return app;
}

module.exports = { criarApp };
