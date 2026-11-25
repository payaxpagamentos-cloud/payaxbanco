'use strict';

const express = require('express');
const config = require('./config');
const { autenticar, permitir, comPerfilVisualizacao } = require('./auth');
const { ErroNegocio } = require('./lib/erros');
const { lerConfig } = require('./db');
const transcodificar = require('./lib/transcodificar');

function criarApi(db) {
  const api = express.Router();
  const autenticado = autenticar(db);
  const comPerfil = comPerfilVisualizacao(db);

  // Saúde para o monitoramento: banco de pé, conversor disponível e tamanho da fila.
  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    const fila = db.prepare("SELECT COUNT(*) AS n FROM conversoes WHERE situacao IN ('fila','convertendo')").get().n;
    res.json({ ok: true, ffmpeg: transcodificar.temFfmpeg(), conversoes_na_fila: fila });
  });

  /** Dados públicos da tela de entrada: marca, planos à venda, forma de cobrança e vitrine. */
  api.get('/publico', (_req, res) => res.json({
    marca: config.marca,
    pagamentos: config.pagamentos,
    aviso: lerConfig(db).aviso_home,
    planos: db.prepare(`SELECT id, nome, slug, descricao, preco_centavos, periodicidade, telas, perfis_max, qualidade, downloads, canais_ao_vivo, nivel
      FROM planos WHERE ativo = 1 ORDER BY ordem, preco_centavos`).all(),
    // Capas que giram atrás do formulário de entrada. Só título publicado e só com capa
    // pronta — quem ainda não entrou não vê nome de rascunho nem moldura vazia.
    vitrine: db.prepare(`SELECT t.id, t.nome, t.ano, t.tipo, t.capa_midia_id AS capa, t.banner_midia_id AS banner
      FROM titulos t JOIN midias m ON m.id = t.capa_midia_id
      WHERE t.situacao = 'publicado' AND m.tipo = 'imagem' AND m.status = 'pronta'
      ORDER BY t.publicado_em DESC, t.id DESC LIMIT 16`).all(),
  }));

  api.use('/auth', require('./routes/auth')(db, autenticado));
  // Capas, banners e logos: públicos e cacheáveis (é o que entra em <img>).
  api.use('/arte', require('./routes/arte')(db));
  // Reprodução (listas HLS, segmentos e vídeo): confere o token assinado do player, não a sessão.
  api.use('/play', require('./routes/play')(db, autenticado, comPerfil));
  api.use('/conta', autenticado, require('./routes/conta')(db));
  api.use('/tv', autenticado, comPerfil, require('./routes/app')(db));
  api.use('/admin', autenticado, permitir('admin', 'curador'), require('./routes/admin')(db));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

function tratarErro(err, res) {
  if (res.headersSent) return res.end();
  if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Requisição grande demais.' });
  if (/UNIQUE constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Já existe um cadastro com esses dados.' });
  if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.' });
  console.error(err);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
}

module.exports = { criarApi, tratarErro };
