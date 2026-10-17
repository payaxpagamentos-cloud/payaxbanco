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
  // Sistema da equipe em BPO_BASE_PATH (ex.: /bpo) e Portal do Cliente em BPO_PORTAL_PATH (ex.: /bpo-cliente).
  // Os dois endereços servem a mesma API (<endereço>/api) e os mesmos arquivos de estilo e scripts.
  const api = criarApi(db);
  const publico = path.join(__dirname, '..', 'public');
  const montar = (pagina) => {
    const r = express.Router();
    r.use(['/api/auth/login', '/api/auth/2fa/login'], limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
    // O importador de extrato tem limite próprio (maior); as demais rotas aceitam até 200 kB.
    r.use((req, res, next) => (/\/(extrato|lancamentos)\/importar$/.test(req.path) ? next() : express.json({ limit: '200kb' })(req, res, next)));
    r.use('/api', api);
    r.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(publico, pagina)));
    r.use(express.static(publico, { index: false }));
    return r;
  };
  // "/bpo" e "/bpo-cliente" sem a barra final levam ao endereço com a barra; o Portal antigo dentro do sistema, ao novo.
  const portalAntigo = `${config.basePath}/portal`;
  app.get(/.*/, (req, res, next) => {
    const url = req.originalUrl.split('?')[0];
    if (url === '/' && config.basePath) return res.redirect(`${config.basePath}/`);
    if (config.basePath && url === config.basePath) return res.redirect(`${config.basePath}/`);
    if (url === config.portalPath) return res.redirect(`${config.portalPath}/`);
    if (config.portalPath !== portalAntigo && (url === portalAntigo || url === `${portalAntigo}/`)) return res.redirect(`${config.portalPath}/`);
    next();
  });
  app.use(config.portalPath, montar('portal/index.html'));
  app.use(config.basePath || '/', montar('index.html'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => tratarErro(err, res));
  return app;
}

module.exports = { criarApp };
