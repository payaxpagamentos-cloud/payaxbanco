'use strict';

const { Router } = require('express');
const { autenticar, permitir } = require('./auth');
const { alcada } = require('./lib/alcadas');
const seguranca = require('./lib/seguranca');
const antifraude = require('./lib/antifraude');
const { ErroNegocio } = require('./lib/erros');
const { criarServicoBradesco } = require('./integracoes/bradesco');

/** Monta o roteador /api com autenticação e permissões por perfil. */
function criarApi(db, bradesco = criarServicoBradesco(db)) {
  const api = Router();
  const auth = autenticar(db);
  seguranca.configurar({ bradesco });
  api.use(seguranca.contarRequisicoes);
  api.get('/saude', (_req, res) => res.json({ status: 'ok', sistema: 'Banqueiro PAY AX' }));
  api.use('/auth', require('./routes/auth')(db));
  // Depois de cada operação do cliente que dá certo, o antifraude analisa o que entrou (servidor Node).
  api.use('/ib', (req, res, next) => {
    if (req.method === 'POST' && typeof res.on === 'function') {
      res.on('finish', () => { if (res.statusCode < 400) { try { antifraude.analisar(db); } catch { /* volta a analisar no painel e de hora em hora */ } } });
    }
    next();
  }, require('./routes/ib')(db, bradesco));
  api.use('/dashboard', auth, require('./routes/dashboard')(db));
  api.use('/clientes', auth, require('./routes/clientes')(db));
  api.use('/aberturas', auth, require('./routes/aberturas')(db));
  api.use('/contas', auth, require('./routes/contas')(db));
  api.use('/operacoes', auth, require('./routes/operacoes')(db));
  api.use('/transacoes', auth, require('./routes/transacoes')(db));
  api.use('/pix', auth, require('./routes/pix')(db));
  api.use('/emprestimos', auth, require('./routes/emprestimos')(db));
  api.use('/relatorios', auth, alcada(db, 'relatorios.ver'), require('./routes/relatorios')(db));
  api.use('/usuarios', auth, permitir('admin'), require('./routes/usuarios')(db));
  api.use('/alcadas', auth, permitir('admin'), require('./routes/alcadas')(db));
  api.use('/ouvidoria', auth, require('./routes/ouvidoria')(db));
  api.use('/seguranca', auth, permitir('admin'), require('./routes/seguranca')(db));
  api.use('/antifraude', auth, alcada(db, 'antifraude.analisar'), require('./routes/antifraude')(db));
  api.use('/relacionamento', auth, require('./routes/relacionamento')(db));
  api.use('/integracoes/bradesco/webhook', require('./routes/bradesco-webhook')(db, bradesco));
  api.use('/integracoes/bradesco', auth, require('./routes/bradesco')(db, bradesco));
  api.use('/auditoria', auth, alcada(db, 'auditoria.ver'), require('./routes/auditoria')(db));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

/** Converte erros em respostas JSON. */
function tratarErro(err, res) {
  if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.' });
  console.error(err);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
}

module.exports = { criarApi, tratarErro };
