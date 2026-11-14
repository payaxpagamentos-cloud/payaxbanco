'use strict';

const express = require('express');
const config = require('./config');
const { autenticarEquipe, autenticarCliente } = require('./auth');
const { ErroNegocio } = require('./lib/erros');
const { idempotencia } = require('./lib/http');

/** API da equipe PAY AX (backoffice). */
function criarApi(db) {
  const api = express.Router();
  const autenticado = autenticarEquipe(db);

  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, modo_banco: config.banco.modo });
  });

  // Sem sessão: aviso do banco e ficha de compensação por link assinado.
  api.use('/publico', require('./routes/publico')(db));

  api.use('/auth', require('./routes/auth')(db, autenticado));
  api.use(autenticado, idempotencia(db));
  api.use('/consultas', require('./routes/consultas')(db));
  api.use('/painel', require('./routes/painel')(db));
  api.use('/clientes', require('./routes/clientes')(db));
  api.use('/boletos', require('./routes/boletos')(db));
  api.use('/repasses', require('./routes/repasses')(db));
  api.use('/contas', require('./routes/contas')(db));
  api.use('/integracoes', require('./routes/integracoes')(db));
  api.use('/arquivos', require('./routes/arquivos')(db));
  api.use('/relatorios', require('./routes/relatorios')(db));
  api.use('/seguranca', require('./routes/seguranca')(db));
  api.use('/admin', require('./routes/admin')(db));
  api.use('/conformidade', require('./routes/conformidade')(db));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

/** API do Internet Bank (cliente final), com audiência de token própria. */
function criarApiCliente(db) {
  const api = express.Router();
  api.get('/saude', (_req, res) => res.json({ ok: true }));
  api.use(require('./routes/cliente')(db, [autenticarCliente(db), idempotencia(db)]));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

function tratarErro(err, req, res) {
  if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes, request_id: req.requestId });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.', request_id: req.requestId });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Requisição grande demais.', request_id: req.requestId });
  if (/UNIQUE constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Já existe um registro com esses dados.', request_id: req.requestId });
  if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.', request_id: req.requestId });
  console.error(`[PAY AX] ${req.requestId}`, err);
  return res.status(500).json({ erro: 'Erro interno do servidor.', request_id: req.requestId });
}

module.exports = { criarApi, criarApiCliente, tratarErro };
