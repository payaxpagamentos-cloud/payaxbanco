'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');

// media-src/img-src com blob: para tocar os áudios e abrir as imagens que o cliente manda pelo WhatsApp;
// mediastream: e o wss:// do Asterisk para o telefone do painel (WebRTC), quando configurado.
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; "
  + `media-src 'self' blob: mediastream:; connect-src 'self'${config.webrtc.origem ? ` ${config.webrtc.origem}` : ''}; frame-ancestors 'none'`;

function criarApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=(self)',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': CSP,
    });
    next();
  });
  // Tudo é servido em ATEND_BASE_PATH (ex.: /atendimento): o painel e a API em <endereço>/api.
  const r = express.Router();
  r.use('/api/auth/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // `corpoCru` guarda o JSON como veio: a assinatura do webhook da Meta é calculada sobre os bytes originais.
  r.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.corpoCru = buf; } }));
  r.use(express.urlencoded({ extended: false, limit: '64kb' }));
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
