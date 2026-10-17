'use strict';

const express = require('express');
const config = require('./config');
const { autenticar } = require('./auth');
const { ErroNegocio } = require('./lib/erros');

function criarApi(db) {
  const api = express.Router();
  const autenticado = autenticar(db);

  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  /** Configuração pública das páginas: camada do mapa, centro padrão e modo de pagamento. */
  api.get('/publico', (_req, res) => res.json({ mapa: config.mapa, busca_enderecos: Boolean(config.geocoder.url), pagamentos: config.pagamentos }));

  api.use('/auth', require('./routes/auth')(db, autenticado));
  api.use('/geo', autenticado, require('./routes/geo')());
  api.use('/passageiro', autenticado, require('./routes/passageiro')(db));
  api.use('/motorista', autenticado, require('./routes/motorista')(db));
  api.use('/central', autenticado, require('./routes/central')(db));
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
