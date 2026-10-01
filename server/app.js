'use strict';

const path = require('node:path');
const express = require('express');
const { autenticar, permitir } = require('./auth');
const { ErroNegocio } = require('./lib/erros');

function criarApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '100kb' }));

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  const api = express.Router();
  const auth = autenticar(db);
  api.get('/saude', (_req, res) => res.json({ status: 'ok', sistema: 'Banqueiro PAY AX' }));
  api.use('/auth', require('./routes/auth')(db));
  api.use('/dashboard', auth, require('./routes/dashboard')(db));
  api.use('/clientes', auth, require('./routes/clientes')(db));
  api.use('/contas', auth, require('./routes/contas')(db));
  api.use('/operacoes', auth, require('./routes/operacoes')(db));
  api.use('/transacoes', auth, require('./routes/transacoes')(db));
  api.use('/pix', auth, require('./routes/pix')(db));
  api.use('/emprestimos', auth, require('./routes/emprestimos')(db));
  api.use('/relatorios', auth, permitir('admin', 'gerente'), require('./routes/relatorios')(db));
  api.use('/usuarios', auth, permitir('admin'), require('./routes/usuarios')(db));
  api.use('/auditoria', auth, permitir('admin', 'gerente'), require('./routes/auditoria')(db));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  app.use('/api', api);

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
    if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.' });
    console.error(err);
    res.status(500).json({ erro: 'Erro interno do servidor.' });
  });

  return app;
}

module.exports = { criarApp };
