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
      // HSTS de 2 anos: depois do primeiro acesso, o navegador só abre os endereços da PAY AX com cadeado.
      ...(config.producao ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
      'Content-Security-Policy': CSP,
    });
    next();
  });

  // ------------------------------------------------- Backoffice PAY AX
  const equipe = express.Router();
  equipe.use('/api/auth/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  // Código de 6 dígitos: sem limite, dá para tentar todos dentro dos 5 minutos do desafio.
  equipe.post('/api/auth/2fa', limitar({ janelaMs: 60_000, maximo: config.limite2faPorMinuto }));
  // O retorno do banco chega como arquivo (corpo bruto); o resto da API é JSON.
  equipe.use('/api/arquivos/retornos', express.raw({ type: () => true, limit: '10mb' }));
  // Abertura de conta pelo site: leva o contrato social (até 8 MB, em base64) no próprio pedido.
  equipe.use('/api/publico/abertura', express.json({ limit: '25mb' }));
  const jsonGrande = express.json({ limit: '25mb' });
  equipe.use('/api/aberturas', (req, res, next) => (req.method === 'POST' && /^\/\d+\/documentos$/.test(req.path) ? jsonGrande(req, res, next) : next()));
  equipe.use(express.json({ limit: '1mb' }));
  // Aviso de privacidade e canal do titular (LGPD): públicos, sem login, nas duas áreas.
  const privacidade = require('./routes/privacidade')(db);
  equipe.use(privacidade);
  equipe.use('/api', criarApi(db));
  equipe.use('/comum', express.static(path.join(__dirname, '..', 'comum'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  equipe.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // ------------------------------------------------- Área do Cliente do cliente final
  const cliente = express.Router();
  cliente.use('/api/auth/login', limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto }));
  cliente.post('/api/auth/2fa', limitar({ janelaMs: 60_000, maximo: config.limite2faPorMinuto }));
  cliente.use(express.json({ limit: '1mb' }));
  cliente.use(privacidade);
  cliente.use('/api', criarApiCliente(db));
  cliente.use('/comum', express.static(path.join(__dirname, '..', 'comum'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  cliente.use('/js/boleto.js', express.static(path.join(__dirname, '..', 'public', 'js', 'boleto.js')));
  cliente.use(express.static(path.join(__dirname, '..', 'cliente'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // ------------------------------------------------- Ativação do acesso (acesso.payax.com.br)
  // Só a página de ativação e a API dela. Fora desse endereço, a mesma página fica em /ativar.
  const pastaAcesso = path.join(__dirname, '..', 'acesso');
  const paginaAcesso = (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(pastaAcesso, 'index.html'));
  const estaticoAcesso = express.static(pastaAcesso, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') });
  equipe.get('/ativar', paginaAcesso);
  equipe.use('/acesso', estaticoAcesso);
  app.use((req, res, next) => {
    if (!config.acessoHosts.includes(String(req.hostname || '').toLowerCase())) return next();
    if (req.path === '/' || req.path === '/ativar') return paginaAcesso(req, res);
    if (req.path.startsWith('/acesso/')) { req.url = req.url.slice('/acesso'.length); return estaticoAcesso(req, res, () => res.status(404).type('text').send('Não encontrado.')); }
    if (req.path.startsWith('/api/publico/ativacao')) return equipe(req, res, next);
    if (/^\/privacidade(\/|$)/.test(req.path)) return next();
    return res.status(404).type('text').send('Página não encontrada.');
  });

  // ------------------------------------------------- Site público (payax.com.br)
  const pastaSite = path.join(__dirname, '..', 'site');
  const site = express.Router();
  site.get('/', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(pastaSite, 'index.html')));
  site.get('/abrir-conta', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(pastaSite, 'abrir-conta.html')));
  site.use('/site', express.static(pastaSite, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.use((req, res, next) => {
    if (!config.siteHosts.includes(String(req.hostname || '').toLowerCase())) return next();
    if (req.path === '/' || req.path === '/abrir-conta' || req.path.startsWith('/site/')) return site(req, res, next);
    // O formulário de abertura de conta envia para a API pública (sem sessão).
    if (req.path.startsWith('/api/publico/abertura')) return equipe(req, res, next);
    // No domínio do site: a Área do Cliente, o aviso de privacidade e os arquivos comuns. Nada do Backoffice.
    if (/^\/(cliente|privacidade|comum)(\/|$)/.test(req.path)) return next();
    return res.status(404).type('text').send('Página não encontrada.');
  });

  // A Área do Cliente precisa vir antes quando mora dentro do caminho do backoffice (ex.: /pagamentos/cliente).
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
