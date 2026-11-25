'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');
const { origensCadastradas, versaoAtual } = require('./lib/embed');

/**
 * Política de segurança das páginas. O player roda em casa: vídeo e listas HLS vêm do nosso servidor
 * ('self') e dos pedaços montados pelo hls.js em memória (blob:). Canais que tocam direto na origem
 * exigem o domínio da emissora em TV_ORIGENS_MIDIA.
 */
const origens = config.origensMidia.map((h) => (h.includes('://') ? h : `https://${h}`)).join(' ');

/** Monta a política de segurança da página, liberando só as origens dos players oficiais cadastrados. */
const montarCsp = (origensEmbed = []) => [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  `media-src 'self' blob: data:${origens ? ` ${origens}` : ''}`,
  `connect-src 'self' blob:${origens ? ` ${origens}` : ''}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Canais com fonte "embed" abrem o player da própria emissora: só os domínios cadastrados entram.
  `frame-src 'self'${origensEmbed.length ? ` ${origensEmbed.join(' ')}` : ''}`,
  "frame-ancestors 'none'",
].join('; ');

function criarApp(db) {
  const app = express();
  // Guarda as origens dos players oficiais para não consultar o banco a cada página, mas refaz
  // na hora em que um canal muda (e, de qualquer forma, a cada minuto).
  let cspAtual = montarCsp(origensCadastradas(db));
  let cspEm = Date.now();
  let cspVersao = versaoAtual();
  const csp = () => {
    if (cspVersao !== versaoAtual() || Date.now() - cspEm > 60_000) {
      cspAtual = montarCsp(origensCadastradas(db));
      cspEm = Date.now();
      cspVersao = versaoAtual();
    }
    return cspAtual;
  };
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'fullscreen=(self), picture-in-picture=(self), autoplay=(self), geolocation=(), camera=(), microphone=()',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': csp(),
    });
    next();
  });

  // Tudo é servido em TV_BASE_PATH (ex.: /tv): páginas, arquivos e a API em <endereço>/api.
  const r = express.Router();
  // Os apps de TV levam a interface dentro do aparelho e chamam a API de outra origem.
  // A autenticação é por token no cabeçalho (não por cookie), então liberar a leitura é seguro:
  // sem o token, nada responde.
  r.use('/api', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Perfil, X-Perfil-Chave, Range',
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
      'Access-Control-Max-Age': '86400',
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });
  r.use(['/api/auth/login', '/api/auth/cadastro', '/api/auth/senha-recuperar'], limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // Os pedaços de vídeo do painel chegam como application/octet-stream e são lidos pela própria rota (sem JSON).
  r.use(express.json({ limit: '200kb' }));
  r.use('/api', criarApi(db));

  const publico = path.join(__dirname, '..', 'public');
  // hls.js servido do próprio pacote, sem CDN.
  r.use('/vendor/hls', express.static(path.join(path.dirname(require.resolve('hls.js/package.json')), 'dist'), { maxAge: '7d', index: false }));
  // "/admin" sem a barra final leva a "/admin/" (as páginas usam caminhos relativos à pasta).
  r.get(/^\/admin$/, (req, res) => res.redirect(`${req.baseUrl}${req.path}/`));
  // A casca do app (páginas, css, js e o próprio service worker) não leva nome com versão,
  // então não pode ficar guardada por tempo fixo: numa atualização o navegador continuaria
  // servindo a anterior por até uma hora. Com 'no-cache' ele revalida pelo ETag e, quando nada
  // mudou, a resposta é um 304 sem corpo — barato. Arte e fonte seguem com validade longa.
  const SEM_GUARDAR = /\.(html|js|css|webmanifest)$/i;
  r.use(express.static(publico, {
    maxAge: config.producao ? '1h' : 0,
    setHeaders(res, caminho) {
      if (SEM_GUARDAR.test(caminho)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
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
