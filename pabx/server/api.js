'use strict';

const express = require('express');
const { autenticar, acessoEmpresa } = require('./auth');
const { ErroNegocio } = require('./lib/erros');
const { lerConfig } = require('./db');

function criarApi(db) {
  const api = express.Router();
  const autenticado = autenticar(db);
  const bloqueado = db.prepare('SELECT 1 FROM ips_bloqueados WHERE ip = ?');

  // IPs bloqueados pelo master não acessam nada da API.
  api.use((req, _res, next) => (bloqueado.get(req.ip) ? next(new ErroNegocio('Acesso bloqueado.', 403)) : next()));

  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  api.get('/publico', (_req, res) => res.json({ nome: lerConfig(db).nome_plataforma }));

  api.use('/auth', require('./routes/auth')(db, autenticado));
  api.use('/integracao', require('./routes/integracao')(db));
  api.use('/master', autenticado, require('./routes/master')(db));
  api.use('/empresas/:eid', autenticado, acessoEmpresa(db), require('./routes/empresa')(db));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

function tratarErro(err, res) {
  if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Requisição grande demais.' });
  if (/UNIQUE constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Já existe um cadastro com esses dados.' });
  if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.' });
  console.error(err);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
}

module.exports = { criarApi, tratarErro };
