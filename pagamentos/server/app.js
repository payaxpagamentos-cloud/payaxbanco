'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, criarApiCliente, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');
const { requestId } = require('./lib/http');

const CSP = [`default-src 'self'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`, `font-src 'self'`,
  `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'`].join('; ');

function criarApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use(requestId);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': CSP,
    });
    next();
  });

  // ------------------------------------------------- Backoffice PayAx
  const equipe = express.Router();
  equipe.use('/api/auth/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // O retorno do banco chega como arquivo (corpo bruto); o resto da API é JSON.
  equipe.use('/api/arquivos/retornos', express.raw({ type: () => true, limit: '10mb' }));
  equipe.use(express.json({ limit: '1mb' }));
  equipe.use('/api', criarApi(db));
  equipe.use('/comum', express.static(path.join(__dirname, '..', 'comum'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  equipe.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // ------------------------------------------------- Internet Bank do cliente final
  const cliente = express.Router();
  cliente.use('/api/auth/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  cliente.use(express.json({ limit: '1mb' }));
  cliente.use('/api', criarApiCliente(db));
  cliente.use('/comum', express.static(path.join(__dirname, '..', 'comum'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  cliente.use('/js/boleto.js', express.static(path.join(__dirname, '..', 'public', 'js', 'boleto.js')));
  cliente.use(express.static(path.join(__dirname, '..', 'cliente'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // O Internet Bank precisa vir antes quando mora dentro do caminho do backoffice (ex.: /pagamentos/cliente).
  app.use(config.clientePath || '/cliente', cliente);
  if (config.basePath) {
    app.get(config.basePath, (req, res, next) => (req.originalUrl.split('?')[0] === config.basePath ? res.redirect(`${config.basePath}/`) : next()));
    app.get('/', (_req, res) => res.redirect(`${config.basePath}/`));
  }
  app.use(config.basePath || '/', equipe);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => tratarErro(err, req, res));
  return app;
}

module.exports = { criarApp };
