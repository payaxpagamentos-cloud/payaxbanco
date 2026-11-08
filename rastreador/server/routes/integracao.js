'use strict';

const { Router } = require('express');
const { ErroNegocio } = require('../lib/erros');
const { lerChave } = require('../lib/contas');
const { receber, EVENTOS } = require('../lib/posicoes');
const { veiculosMapa } = require('../lib/relatorios');
const { TIPOS: TIPOS_ALERTA } = require('../lib/alertas');
const com = require('../lib/comandos');
const v = require('../lib/validacao');

const MAX_LOTE = 500;

/**
 * API de integração, autenticada pela chave da empresa (X-Api-Key): consulta da frota e das posições para outros sistemas (ERP, TMS)
 * e envio de posições e respostas de comandos por um servidor intermediário (gateway de outro protocolo, Traccar etc.).
 */
module.exports = (db) => {
  const r = Router();

  r.use((req, _res, next) => {
    const auth = req.get('authorization') || '';
    const empresa = lerChave(db, req.get('x-api-key') || (auth.startsWith('Bearer ') ? auth.slice(7) : ''));
    if (!empresa) return next(new ErroNegocio('Chave de API inválida ou revogada.', 401));
    if (empresa.status !== 'ativa') return next(new ErroNegocio('Empresa bloqueada.', 403));
    req.empresa = empresa;
    next();
  });

  const veiculoPorPlaca = (req) => {
    const x = db.prepare('SELECT * FROM veiculos WHERE empresa_id = ? AND placa = ?').get(req.empresa.id, v.placa(req.params.placa));
    if (!x) throw new ErroNegocio('Veículo não encontrado.', 404);
    return x;
  };

  /** Frota com a última posição e a situação de cada veículo. */
  r.get('/veiculos', (req, res) => {
    res.json(veiculosMapa(db, req.empresa.id).map((x) => ({
      placa: x.placa, descricao: x.descricao, tipo: x.tipo, situacao: x.situacao, lat: x.lat, lng: x.lng, velocidade_kmh: x.velocidade_kmh, curso: x.curso,
      ignicao: x.ignicao === null ? null : Boolean(x.ignicao), bloqueado: Boolean(x.bloqueado), posicao_em: x.posicao_em, comunicacao_em: x.comunicacao_em,
      hodometro_km: Math.floor(x.hodometro_m / 1000), motorista: x.motorista, imei: x.imei,
    })));
  });

  /** Posições de um veículo entre `de` e `ate` (ISO 8601; até 7 dias, até 20.000 posições). */
  r.get('/veiculos/:placa/posicoes', (req, res) => {
    const x = veiculoPorPlaca(req);
    const ate = req.query.ate ? Date.parse(req.query.ate) : Date.now();
    const de = req.query.de ? Date.parse(req.query.de) : ate - 24 * 3600_000;
    v.exigir(Number.isFinite(de) && Number.isFinite(ate) && de < ate && ate - de <= 7 * 24 * 3600_000, 'Período inválido (de e ate em ISO 8601, até 7 dias).');
    res.json(db.prepare(`SELECT lat, lng, velocidade_kmh, curso, altitude, satelites, ignicao, tensao, evento, gps_em FROM posicoes
      WHERE veiculo_id = ? AND gps_em >= ? AND gps_em < ? ORDER BY gps_em LIMIT 20000`).all(x.id, new Date(de).toISOString(), new Date(ate).toISOString()));
  });

  /** Alertas desde `desde` (ISO; padrão: últimas 24 h), do mais antigo ao mais novo, para quem consulta de tempos em tempos. */
  r.get('/alertas', (req, res) => {
    const desde = req.query.desde ? Date.parse(req.query.desde) : Date.now() - 24 * 3600_000;
    v.exigir(Number.isFinite(desde), 'Data inválida em desde (use ISO 8601).');
    res.json(db.prepare(`SELECT a.id, a.tipo, a.mensagem, a.lat, a.lng, a.velocidade_kmh, a.ocorrido_em, a.tratado_em, v.placa FROM alertas a
      JOIN veiculos v ON v.id = a.veiculo_id WHERE a.empresa_id = ? AND a.ocorrido_em > ? ORDER BY a.ocorrido_em LIMIT 1000`)
      .all(req.empresa.id, new Date(desde).toISOString()).map((a) => ({ ...a, tipo_nome: TIPOS_ALERTA[a.tipo] })));
  });

  /**
   * Posições enviadas por outro sistema: uma ou uma lista (até 500) de
   * { imei, lat, lng, velocidade_kmh?, curso?, altitude?, satelites?, ignicao?, tensao?, evento?, gps_em? }.
   * Só os rastreadores desta empresa são aceitos.
   */
  r.post('/posicoes', (req, res) => {
    const lista = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.posicoes) ? req.body.posicoes : [req.body];
    v.exigir(lista.length >= 1 && lista.length <= MAX_LOTE, `Envie de 1 a ${MAX_LOTE} posições por vez.`);
    const daEmpresa = db.prepare('SELECT 1 FROM rastreadores WHERE imei = ? AND empresa_id = ?');
    const resultado = lista.map((p, i) => {
      if (!p || typeof p !== 'object' || !/^[A-Za-z0-9._-]{4,40}$/.test(String(p.imei ?? ''))) return { indice: i, status: 'invalida', erro: 'imei ausente ou inválido' };
      if (!daEmpresa.get(String(p.imei), req.empresa.id)) return { indice: i, status: 'desconhecido', erro: 'rastreador não cadastrado nesta empresa' };
      const x = receber(db, {
        imei: String(p.imei), protocolo: 'api', ip: req.ip, lat: p.lat, lng: p.lng ?? p.lon, velocidade_kmh: p.velocidade_kmh, curso: p.curso, altitude: p.altitude,
        satelites: p.satelites, ignicao: typeof p.ignicao === 'boolean' ? p.ignicao : null, tensao: p.tensao, evento: EVENTOS.includes(p.evento) ? p.evento : null,
        bloqueado: typeof p.bloqueado === 'boolean' ? p.bloqueado : undefined, gps_em: p.gps_em,
      });
      return { indice: i, status: x.status };
    });
    res.json({ recebidas: resultado.filter((x) => x.status === 'gravada').length, resultado });
  });

  /**
   * Comandos pendentes dos rastreadores desta empresa com o protocolo "api": o sistema intermediário busca, entrega ao equipamento
   * e informa o resultado. Os comandos devolvidos aqui passam a "enviado".
   */
  r.get('/comandos', (req, res) => {
    const lista = db.prepare(`SELECT c.id, c.tipo, c.texto, c.criado_em, r.imei, v.placa FROM comandos c JOIN rastreadores r ON r.id = c.rastreador_id
      JOIN veiculos v ON v.id = c.veiculo_id WHERE c.empresa_id = ? AND c.status = 'pendente' AND r.protocolo = 'api' ORDER BY c.id LIMIT 100`).all(req.empresa.id);
    for (const c of lista) com.marcarEnviado(db, c.id);
    res.json(lista);
  });

  /** Resultado do comando: { sucesso: true|false, resposta? }. */
  r.post('/comandos/:id', (req, res) => {
    const c = db.prepare("SELECT id FROM comandos WHERE id = ? AND empresa_id = ? AND status IN ('pendente','enviado')").get(Number(req.params.id), req.empresa.id);
    if (!c) throw new ErroNegocio('Comando não encontrado ou já respondido.', 404);
    com.responder(db, c.id, { sucesso: v.booleano(req.body.sucesso), resposta: req.body.resposta });
    res.json({ ok: true });
  });

  return r;
};
