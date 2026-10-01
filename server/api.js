'use strict';

const { Router } = require('express');
const { autenticar, permitir } = require('./auth');
const { ErroNegocio } = require('./lib/erros');
const { criarServicoBradesco } = require('./integracoes/bradesco');

/** Monta o roteador /api com autenticação e permissões por perfil. */
function criarApi(db, bradesco = criarServicoBradesco(db)) {
  const api = Router();
  const auth = autenticar(db);
  api.get('/saude', (_req, res) => res.json({ status: 'ok', sistema: 'Banqueiro PAY AX' }));
  api.use('/auth', require('./routes/auth')(db));
  api.use('/ib', require('./routes/ib')(db, bradesco));
  api.use('/dashboard', auth, require('./routes/dashboard')(db));
  api.use('/clientes', auth, require('./routes/clientes')(db));
  api.use('/aberturas', auth, require('./routes/aberturas')(db));
  api.use('/contas', auth, require('./routes/contas')(db));
  api.use('/operacoes', auth, require('./routes/operacoes')(db));
  api.use('/transacoes', auth, require('./routes/transacoes')(db));
  api.use('/pix', auth, require('./routes/pix')(db));
  api.use('/emprestimos', auth, require('./routes/emprestimos')(db));
  api.use('/relatorios', auth, permitir('admin', 'gerente'), require('./routes/relatorios')(db));
  api.use('/usuarios', auth, permitir('admin'), require('./routes/usuarios')(db));
  api.use('/integracoes/bradesco/webhook', require('./routes/bradesco-webhook')(db, bradesco));
  api.use('/integracoes/bradesco', auth, require('./routes/bradesco')(db, bradesco));
  api.use('/auditoria', auth, permitir('admin', 'gerente'), require('./routes/auditoria')(db));
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
