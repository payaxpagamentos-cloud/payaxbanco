'use strict';

const express = require('express');
const { autenticar, acessoEmpresa } = require('./auth');
const { ErroNegocio } = require('./lib/erros');
const { lerConfig } = require('./db');
const { hoje } = require('./lib/datas');

function criarApi(db) {
  const api = express.Router();
  const autenticado = autenticar(db);

  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  // `hoje` é o dia no fuso do servidor: o painel usa essa data nos filtros, não a do computador do balcão.
  api.get('/publico', (_req, res) => res.json({ nome: lerConfig(db).nome_plataforma, hoje: hoje() }));

  api.use('/auth', require('./routes/auth')(db, autenticado));
  // Maquininhas: autenticadas pela chave do terminal, não por usuário.
  api.use('/integracao', require('./routes/integracao')(db));
  // Tela do cliente (autoatendimento): autenticada pela chave do PDV.
  api.use('/autoatendimento', require('./routes/autoatendimento')(db));
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
