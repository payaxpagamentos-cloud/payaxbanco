'use strict';

const express = require('express');
const config = require('./config');
const { autenticar, exigir } = require('./auth');
const { ErroNegocio } = require('./lib/erros');
const { ErroEquipamento } = require('./drivers/base');
const { idempotencia } = require('./lib/http');
const anexos = require('./lib/anexos');

function criarApi(db, extras = {}) {
  const api = express.Router();
  const autenticado = autenticar(db);

  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  /*
   * Configuração do mapa. Exige sessão: a chave do Google vai para o navegador de qualquer jeito (é assim
   * que a API funciona), mas não há motivo para entregá-la a quem nem entrou no sistema. Quem protege a
   * conta de verdade é a restrição por referenciador HTTP no console do Google.
   */
  api.get('/publico', autenticado, (req, res) => res.json({ mapa: config.mapa }));

  /*
   * Portal do assinante. Montado ANTES da autenticação da equipe, de propósito: ele tem o próprio
   * verificador e o próprio público de token, e nada aqui deve passar pelo middleware interno.
   */
  api.use('/portal', require('./routes/portal')(db));

  // Arquivo por link temporário assinado (para <img> e abrir comprovantes); a permissão é conferida de novo aqui.
  api.get('/arquivos/:id', (req, res) => {
    if (!anexos.conferirLink(req.params.id, req.query.u, req.query.e, req.query.s)) throw new ErroNegocio('Link expirado ou inválido.', 403);
    const a = db.prepare('SELECT * FROM anexos WHERE id = ?').get(Number(req.params.id));
    const u = db.prepare('SELECT u.*, t.id AS tecnico_id FROM usuarios u LEFT JOIN tecnicos t ON t.usuario_id = u.id WHERE u.id = ? AND u.ativo = 1').get(Number(req.query.u));
    if (!a || !u || !anexos.podeVer(db, u, a)) throw new ErroNegocio('Acesso negado.', 403);
    const inline = /^image\//.test(a.mime) || a.mime === 'application/pdf';
    res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.nome)}`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    res.send(anexos.conteudo(a));
  });

  // Entrada do roteador do assinante (TR-069). Credencial própria do ACS, não usa sessão de usuário.
  api.use('/acs', require('./routes/acs')(db));

  // Entrada autenticada do coletor de monitoramento (token próprio, não usa sessão de usuário).
  api.use('/coletor', require('./routes/coletor')(db));

  api.use('/auth', require('./routes/auth')(db, autenticado));
  api.use(autenticado, idempotencia(db));
  api.use('/organizacao', require('./routes/organizacao')(db));
  api.use('/anexos', require('./routes/anexos')(db));
  api.use('/painel', exigir('painel.ver'), require('./routes/painel')(db));
  api.use('/consultas', require('./routes/consultas')(db));
  api.use('/assinantes', require('./routes/assinantes')(db));
  api.use('/planos', require('./routes/planos')(db));
  api.use('/contratos', require('./routes/contratos')(db));
  api.use('/faturamento', require('./routes/faturamento')(db));
  api.use('/cobranca', require('./routes/cobranca')(db));
  api.use('/cobrancas', require('./routes/cobrancas')(db));
  api.use('/panorama', require('./routes/panorama')(db));
  api.use('/contabil', require('./routes/contabil')(db));
  api.use('/certificado', require('./routes/certificado')(db));
  api.use('/provisionamento', require('./routes/provisionamento')(db));
  api.use('/cpes', require('./routes/cpes')(db));
  api.use('/frota', require('./routes/frota')(db));
  api.use('/manutencao', require('./routes/manutencao')(db));
  api.use('/combustivel', require('./routes/combustivel')(db));
  api.use('/rede', require('./routes/rede')(db));
  api.use('/chamados', require('./routes/chamados')(db));
  api.use('/equipe', require('./routes/equipe')(db));
  api.use('/noc', require('./routes/noc')(db));
  api.use('/rastreamento', require('./routes/rastreamento')(db, extras));
  api.use('/integracoes', require('./routes/integracoes')(db, extras));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

function tratarErro(err, req, res) {
  if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes, request_id: req.requestId });
  // Erro de equipamento levantado fora da fila (ex.: endereço de gerência inválido ao salvar o acesso):
  // é problema do que foi informado, não falha do servidor.
  if (err instanceof ErroEquipamento) {
    const status = err.estado === 'sem_permissao' ? 403 : err.permanente ? 400 : 502;
    return res.status(status).json({ erro: err.message, estado: err.estado, request_id: req.requestId });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.', request_id: req.requestId });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo ou requisição grande demais.', request_id: req.requestId });
  if (/UNIQUE constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Já existe um registro com esses dados.', request_id: req.requestId });
  if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.', request_id: req.requestId });
  console.error(`[Network] ${req.requestId}`, err);
  return res.status(500).json({ erro: 'Erro interno do servidor.', request_id: req.requestId });
}

module.exports = { criarApi, tratarErro };
