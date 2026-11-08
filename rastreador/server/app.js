'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { criarApi, tratarErro } = require('./api');
const { limitar } = require('./lib/limitador');

/** Origem da camada de imagens do mapa (ex.: https://server.arcgisonline.com), liberada na política de segurança. */
const origemTiles = (() => {
  try {
    return new URL(config.mapa.tiles.replace(/\{s\}/, 'a').replace(/\{[^}]+\}/g, '0')).origin.replace('://a.', '://*.');
  } catch {
    return '';
  }
})();
/** Origens do mapa vetorial (estilo, fontes, ícones e dados vêm do mesmo servidor do estilo). */
const origensVetor = [...new Set([config.mapa.estilo, config.mapa.estilo_escuro].filter(Boolean).map((u) => { try { return new URL(u).origin; } catch { return ''; } }))].join(' ');
/** Origens das imagens de satélite e dos nomes por cima delas. */
const origensSatelite = [...new Set([config.mapa.satelite.tiles, ...config.mapa.satelite.rotulos].map((u) => { try { return new URL(u.replace(/\{[^}]+\}/g, '0')).origin; } catch { return ''; } }))].join(' ');
/** Com a chave do Google: as imagens do mapa, os créditos da área visível e o logo do Google. */
const origensGoogle = config.google.chave ? 'https://tile.googleapis.com https://maps.gstatic.com' : '';
/** Com a chave do Google Maps no navegador (Maps JavaScript API): as origens que o próprio Google pede liberar. */
const gjs = config.google.js_chave;
const gjsImg = gjs ? 'https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com https://*.ggpht.com' : '';
const CSP = [`default-src 'self'`, `img-src 'self' data: blob: ${origemTiles} ${origensVetor} ${origensSatelite} ${origensGoogle} ${gjsImg}`,
  `style-src 'self' 'unsafe-inline'${gjs ? ' https://fonts.googleapis.com' : ''}`, `font-src 'self'${gjs ? ' https://fonts.gstatic.com' : ''}`,
  `script-src 'self'${gjs ? " 'unsafe-eval' blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com" : ''}`,
  `connect-src 'self' ${origensVetor} ${origensSatelite} ${origensGoogle}${gjs ? ' https://*.googleapis.com https://*.google.com https://*.gstatic.com data: blob:' : ''}`,
  `worker-src 'self' blob:`, ...(gjs ? ['frame-src https://*.google.com'] : []), `frame-ancestors 'none'`].join('; ');

function criarApp(db, extras = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // O OpenStreetMap recusa as imagens do mapa sem a origem do site (Referer); só a origem é enviada, nunca o caminho.
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // Localização só para o próprio site (o SOS do app do motorista manda a posição do celular); câmera e microfone, ninguém
      // (as fotos do app vêm pelo seletor de arquivos do celular, que não precisa desta permissão).
      'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Content-Security-Policy': CSP,
    });
    next();
  });
  // Tudo é servido em RASTREADOR_BASE_PATH (ex.: /rastreador): o painel, a página de compartilhamento e a API em <endereço>/api.
  const r = express.Router();
  r.use('/api/auth/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  r.use('/api/motorista/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // Código de liberação: poucas tentativas por minuto (são 6 números).
  r.use(/^\/api\/empresas\/\d+\/liberacoes\/(consultar|aplicar)$/, limitar({ janelaMs: 60_000, maximo: 20 }));
  r.use(/^\/api\/empresas\/\d+\/assistente$/, limitar({ janelaMs: 60_000, maximo: 12 }));
  // App do motorista: fotos do checklist, do abastecimento e da avaria (já reduzidas no celular) e poucos envios por minuto.
  r.use(/^\/api\/motorista\/(sos|checklists|abastecimentos|avarias)$/, limitar({ janelaMs: 60_000, maximo: 10 }));
  r.use('/api/motorista', express.json({ limit: '8mb' }));
  // A API de integração recebe lotes de posições; o app Traccar Client envia formulário ou JSON.
  r.use(express.json({ limit: '1mb' }));
  r.use(express.urlencoded({ extended: false, limit: '100kb' }));
  r.use('/api', criarApi(db, extras));
  // Leaflet (mapa) servido do próprio pacote, sem CDN.
  r.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js')), { maxAge: '7d' }));
  // MapLibre (mapa vetorial) e a ponte dele com o Leaflet, também do próprio pacote.
  r.use('/vendor/maplibre', express.static(path.join(path.dirname(require.resolve('maplibre-gl/package.json')), 'dist'), { maxAge: '7d' }));
  r.get('/vendor/googlemutant.js', (_req, res) => res.sendFile(require.resolve('leaflet.gridlayer.googlemutant/dist/Leaflet.GoogleMutant.js'), { maxAge: '7d' }));
  r.get('/vendor/maplibre-leaflet.js', (_req, res) => res.sendFile(require.resolve('@maplibre/maplibre-gl-leaflet'), { maxAge: '7d' }));
  // "/compartilhar" sem a barra final leva a "/compartilhar/" (a página usa caminhos relativos à pasta).
  r.get(/^\/compartilhar$/, (req, res) => res.redirect(`${req.baseUrl}/compartilhar/`));
  r.get(/^\/motorista$/, (req, res) => res.redirect(`${req.baseUrl}/motorista/`));
  // no-cache: o navegador sempre confere se há versão nova das telas (evita ficar com a versão antiga depois de atualizar).
  r.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
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
