'use strict';

const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const { autenticar, acessoEmpresa } = require('./auth');
const { ErroNegocio } = require('./lib/erros');
const { lerConfig, agora } = require('./db');

/** `extras.gt06`: o servidor dos rastreadores GT06 (conexões abertas e entrega de comandos), quando estiver ligado. */
function criarApi(db, extras = {}) {
  const api = express.Router();
  const autenticado = autenticar(db);

  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  api.get('/publico', (_req, res) => res.json({ nome: lerConfig(db).nome_plataforma, mapa: config.mapa, gt06_porta: config.portaGt06 }));

  /** Localização compartilhada por link (sem login), enquanto o link vale e a empresa está ativa. */
  api.get('/publico/compartilhado/:codigo', (req, res) => {
    const hash = crypto.createHash('sha256').update(String(req.params.codigo)).digest('hex');
    const x = db.prepare(`SELECT v.placa, v.descricao, v.tipo, v.lat, v.lng, v.velocidade_kmh, v.curso, v.ignicao, v.posicao_em, c.expira_em, e.nome AS empresa
      FROM compartilhamentos c JOIN veiculos v ON v.id = c.veiculo_id JOIN empresas e ON e.id = c.empresa_id
      WHERE c.hash = ? AND c.revogado_em IS NULL AND c.expira_em > ? AND e.status = 'ativa' AND v.ativo = 1`).get(hash, agora());
    if (!x) throw new ErroNegocio('Link expirado ou inválido.', 404);
    res.set('Cache-Control', 'no-store').json(x);
  });

  api.use('/auth', require('./routes/auth')(db, autenticado));
  api.use('/osmand', require('./routes/osmand')(db));
  api.use('/integracao', require('./routes/integracao')(db));
  api.use('/master', autenticado, require('./routes/master')(db, extras));
  api.use('/empresas/:eid', autenticado, acessoEmpresa(db), require('./routes/empresa')(db, extras));
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
