'use strict';

const express = require('express');
const config = require('./config');
const { lerConfig } = require('./db');
const { autenticar, permitir } = require('./auth');
const { ErroNegocio } = require('./lib/erros');

function criarApi(db) {
  const api = express.Router();
  const autenticado = autenticar(db);
  // Quem trabalha no mercadinho (o perfil 'morador' só enxerga a própria conta).
  const equipe = permitir('admin', 'gerente', 'caixa', 'estoque');
  const gestao = permitir('admin', 'gerente');
  const operacao = permitir('admin', 'gerente', 'caixa');
  const estoque = permitir('admin', 'gerente', 'estoque');
  const admin = permitir('admin');

  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  /** O que as telas precisam saber antes do login. */
  api.get('/publico', (_req, res) => {
    const cfg = lerConfig(db);
    res.json({ nome_mercado: cfg.nome_mercado, condominio: cfg.condominio, versao: '1.0' });
  });

  api.use('/auth', require('./routes/auth')(db, autenticado));
  // Terminal do balcão: o próprio cliente registra a compra e paga. Tem token e rotas próprias.
  api.use('/terminal', require('./routes/terminal')(db));
  api.use('/painel', autenticado, equipe, require('./routes/painel')(db));
  api.use('/produtos', autenticado, equipe, require('./routes/produtos')(db, { estoque }));
  api.use('/estoque', autenticado, equipe, require('./routes/estoque')(db, { estoque }));
  api.use('/caixa', autenticado, operacao, require('./routes/caixa')(db, { gestao }));
  api.use('/pdv', autenticado, operacao, require('./routes/pdv')(db, { gestao }));
  api.use('/compras', autenticado, estoque, require('./routes/compras')(db, { gestao }));
  api.use('/financeiro', autenticado, gestao, require('./routes/financeiro')(db));
  api.use('/moradores', autenticado, require('./routes/moradores')(db, { equipe, gestao }));
  api.use('/relatorios', autenticado, gestao, require('./routes/relatorios')(db));
  api.use('/admin', autenticado, gestao, require('./routes/admin')(db, { admin }));
  // Vitrine (TV e tablet parado): a sequência é pública; a gestão exige login de gerente ou admin.
  api.use('/vitrine', require('./routes/vitrine')(db, { autenticado, gestao }));

  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

function tratarErro(err, res) {
  if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Requisição grande demais.' });
  if (/UNIQUE constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Já existe um cadastro com esses dados.' });
  if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.' });
  if (!config.producao) console.error(err);
  else console.error(err.message);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
}

module.exports = { criarApi, tratarErro };
