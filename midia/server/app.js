'use strict';

const fs = require('node:fs');
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
  r.use(['/api/auth/login', '/api/auth/recuperar', '/api/auth/nova-senha'], limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // Atualizar o sistema pede a senha de novo: a tentativa conta como uma tentativa de login.
  const limiteAtualizacao = limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto });
  r.use('/api/painel/sistema/atualizacao', (req, res, next) => (req.method === 'POST' ? limiteAtualizacao(req, res, next) : next()));
  // O envio de mídia tem o corpo bruto (arquivo) e limite próprio; o resto é JSON de até 400 kB.
  // O envio de criativo vai no corpo bruto (arquivo) com limite próprio; o resto é JSON de até 400 kB.
  r.use('/api', (req, res, next) => {
    if (req.method !== 'POST') return express.json({ limit: '400kb' })(req, res, next);
    // Criativo e logo: arquivo no corpo bruto, com o limite de mídia.
    if (/^\/(painel|anunciante|ponto)\/midias$|^\/painel\/locais\/\d+\/logo$|^\/(painel|ponto)\/comunicados\/\d+\/imagem$/.test(req.path)) {
      return express.raw({ type: '*/*', limit: config.midiaMaxBytes })(req, res, next);
    }
    // Pacote de atualização do sistema (o vaimidia.zip), enviado pelo painel.
    if (req.path === '/painel/sistema/atualizacao') return express.raw({ type: '*/*', limit: '80mb' })(req, res, next);
    // Foto da tela (prova visual): imagem pequena, limite próprio.
    if (req.path === '/player/foto') return express.raw({ type: '*/*', limit: '600kb' })(req, res, next);
    return express.json({ limit: '400kb' })(req, res, next);
  });
  r.use('/api', criarApi(db));
  // Página do player com o endereço do script e do estilo carimbado pela versão (data dos arquivos):
  // navegador de TV que guarda tudo na memória (Samsung) é obrigado a buscar os arquivos novos depois
  // de cada atualização, sem ninguém precisar limpar o cache da TV.
  const { carimboPlayer, pastaPlayer } = require('./lib/carimbo-player');
  const paginaTv = () => {
    const carimbo = carimboPlayer();
    return fs.readFileSync(path.join(pastaPlayer, 'index.html'), 'utf8')
      .replace('href="tv.css"', `href="tv.css?v=${carimbo}"`)
      .replace('src="diag.js"', `src="diag.js?v=${carimbo}"`)
      .replace('src="player.js"', `src="player.js?v=${carimbo}"`);
  };
  r.get(['/tv/', '/tv/index.html'], (_req, res) => res.type('html').set('Cache-Control', 'no-store').send(paginaTv()));
  // O player precisa poder ser atualizado: a página e o script dele sempre revalidam com o servidor,
  // enquanto fontes, estilos e imagens seguem o cache normal.
  r.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, caminho) => {
      if (/public[\\/]+(tv[\\/]+)?(index\.html|player\.js|tv\.css)$/.test(caminho)) res.set('Cache-Control', 'no-cache');
      // O service worker do player: sempre a versão nova, e autorizado a abrir o player pela raiz (tv.dominio/) sem internet.
      if (/public[\\/]+tv[\\/]+sw\.js$/.test(caminho)) res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    },
  }));
  // Site institucional: servido em <base>/site/ e também na raiz do domínio, que é onde o visitante chega.
  // Quem hospeda o site separado (Vercel, Netlify, nginx) desliga com MIDIA_SITE=0 — a pasta site/ é estática.
  const site = path.join(__dirname, '..', 'site');
  if (config.site && fs.existsSync(site)) {
    // Servido por aqui, o site já sabe onde fica a API (sem precisar sair procurando).
    // O atributo entra na abertura do <body>, que pode já ter outros (data-criativos, por exemplo).
    const montarPagina = () => fs.readFileSync(path.join(site, 'index.html'), 'utf8')
      .replace('<body', `<body data-api="${config.basePath}/api/"`);
    // Em produção a página é lida uma vez; fora dela, a cada pedido, para quem está editando o site ver na hora.
    let pagina = montarPagina();
    const inicio = (_req, res) => res.type('html').set('Cache-Control', 'no-cache').send(config.producao ? pagina : (pagina = montarPagina()));
    r.get(['/site', '/site/', '/site/index.html'], inicio);
    r.use('/site', express.static(site, { index: false }));
    app.get(['/site', '/site/', '/site/index.html'], inicio);
    app.use('/site', express.static(site, { index: false }));
    app.get('/', inicio);
    app.use(express.static(site, { index: false }));
  }
  if (config.basePath) {
    app.get(config.basePath, (req, res, next) => (req.originalUrl.split('?')[0] === config.basePath ? res.redirect(`${config.basePath}/`) : next()));
    if (!config.site || !fs.existsSync(site)) app.get('/', (_req, res) => res.redirect(`${config.basePath}/`));
  }
  // Atalho curto para a página de diagnóstico de tela cheia (digitar com controle remoto é penoso):
  // tv.SEU-DOMINIO/teste.
  app.get('/teste', (_req, res) => res.redirect(302, `${config.basePath}/tv/teste-tela-cheia.html`));
  app.use(config.basePath || '/', r);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => tratarErro(err, res));
  return app;
}

module.exports = { criarApp };
