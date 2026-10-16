'use strict';

const { Router, json } = require('express');
const { autenticar, permitir } = require('./auth');
const { carregarEmpresa } = require('./lib/acesso');
const { ErroNegocio } = require('./lib/erros');

/** Monta o roteador /api. Tudo exige login, exceto /saude e /auth/login. */
function criarApi(db) {
  const api = Router();
  const auth = autenticar(db);
  api.get('/saude', (_req, res) => res.json({ status: 'ok', sistema: 'PAY AX BPO Financeiro' }));
  api.use('/auth', require('./routes/auth')(db, auth));
  api.use('/painel', auth, require('./routes/painel')(db));
  api.use('/usuarios', auth, require('./routes/usuarios')(db));
  api.use('/tarefas', auth, require('./routes/tarefas')(db));
  api.use('/auditoria', auth, permitir('admin', 'supervisor'), require('./routes/auditoria')(db));
  // Extratos podem ser maiores que o limite padrão do corpo.
  api.use('/empresas/:empresaId/extrato/importar', auth, json({ limit: '5mb' }));
  api.use('/empresas/:empresaId', auth, carregarEmpresa(db), require('./routes/financeiro')(db));
  api.use('/empresas', auth, require('./routes/empresas')(db));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

/** Converte erros em respostas JSON. */
function tratarErro(err, res) {
  if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo grande demais.' });
  if (/UNIQUE constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Já existe um cadastro com esses dados.' });
  if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.' });
  console.error(err);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
}

module.exports = { criarApi, tratarErro };
