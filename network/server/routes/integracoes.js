'use strict';

const { Router } = require('express');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const base = require('../conectores/base');
const rastreador = require('../conectores/rastreador');
const downdetector = require('../conectores/downdetector');
const atendimento = require('../conectores/atendimento');
const v = require('../lib/validacao');

const CONECTORES = { rastreador, downdetector, atendimento };

/** Configuração validada por tipo. Nenhum endpoint do Downdetector é presumido: caminho e campos vêm da documentação do acesso. */
function validarConfig(tipo, c = {}) {
  const url = v.texto(c.url_base, 'o endereço base', 300);
  if (tipo === 'rastreador') return { url_base: url.replace(/\/+$/, ''), intervalo_s: v.inteiro(c.intervalo_s ?? 60, 'o intervalo', { min: 30, max: 3600 }) };
  // ZOE Atende: só o endereço, de quanto em quanto tempo ler e quantos meses trazer.
  if (tipo === 'atendimento') {
    return {
      url_base: url.replace(/\/+$/, ''),
      intervalo_s: v.inteiro(c.intervalo_s ?? 900, 'o intervalo', { min: 120, max: 86400 }),
      meses: v.inteiro(c.meses ?? 12, 'os meses do histórico', { min: 1, max: 60 }),
    };
  }
  return {
    url_base: url.replace(/\/+$/, ''), caminho: v.texto(c.caminho, 'o caminho da consulta', 300), cabecalho_auth: v.opcional(c.cabecalho_auth, 'o cabeçalho', 60) ?? 'Authorization',
    prefixo_auth: c.prefixo_auth === undefined ? 'Bearer' : String(c.prefixo_auth).slice(0, 20), campo_relatos: v.texto(c.campo_relatos, 'o campo do volume de relatos', 120),
    campo_baseline: v.opcional(c.campo_baseline, 'o campo de referência', 120), campo_periodo_inicio: v.opcional(c.campo_periodo_inicio, 'o campo de início do período', 120),
    campo_periodo_fim: v.opcional(c.campo_periodo_fim, 'o campo de fim do período', 120), fator_indicio: v.numero(c.fator_indicio ?? 2, 'o fator de indício', { min: 1.1, max: 100 }),
    intervalo_s: v.inteiro(c.intervalo_s ?? 300, 'o intervalo', { min: 120, max: 86400 }),
  };
}

module.exports = (db) => {
  const r = Router();
  const tipoDe = (req) => {
    const t = String(req.params.tipo);
    if (!CONECTORES[t]) throw new ErroNegocio('Integração desconhecida.', 404);
    return t;
  };

  r.get('/', exigir('integracoes.ver'), (req, res) => {
    const o = db.prepare('SELECT desatualizado_min FROM organizacoes WHERE id = ?').get(req.org);
    const lista = Object.entries(CONECTORES).map(([tipo, c]) => {
      const x = base.ler(db, req.org, tipo);
      return { ...base.publico(x, tipo), estado: base.estadoAtual(x, o.desatualizado_min, c.intervalo(x?.config ?? {})),
        sincronizacoes: db.prepare('SELECT * FROM sincronizacoes WHERE organizacao_id = ? AND tipo = ? ORDER BY id DESC LIMIT 10').all(req.org, tipo) };
    });
    const coletores = db.prepare('SELECT id, nome, prefixo, criado_em, ultimo_uso, revogado_em FROM coletores WHERE organizacao_id = ? ORDER BY id DESC').all(req.org);
    const amostras = db.prepare('SELECT fonte, COUNT(*) AS n, MAX(observado_em) AS ultima FROM amostras WHERE organizacao_id = ? AND recebido_em >= ? GROUP BY fonte')
      .all(req.org, new Date(Date.now() - 24 * 3600_000).toISOString());
    res.json({ integracoes: lista, monitoramento: { coletores, amostras_24h: amostras }, downdetector_site: downdetector.SITE_OFICIAL });
  });

  /** Salva configuração e credencial (cifrada; nunca devolvida). segredo omitido mantém a atual; vazio remove. */
  r.put('/:tipo', exigir('integracoes.editar'), async (req, res, next) => {
    try {
      const tipo = tipoDe(req);
      const b = req.body ?? {};
      const cfg = validarConfig(tipo, b.config);
      try { await base.validarDestino(cfg.url_base); } catch (err) { throw new ErroNegocio(err.message, 422); }
      const habilitada = b.habilitada === undefined ? true : v.booleano(b.habilitada);
      const segredo = b.segredo === undefined ? undefined : b.segredo === null ? null : String(b.segredo).trim().slice(0, 500);
      const x = base.salvar(db, req.org, tipo, { config: cfg, segredo, habilitada });
      registrar(db, req, 'integracao_configurada', { recurso: 'integracao', depois: { tipo, config: cfg, habilitada, credencial_alterada: segredo !== undefined } });
      res.json(base.publico(x, tipo));
    } catch (err) { next(err); }
  });

  /** Teste de conexão = uma coleta agora, com o resultado detalhado (estado, mensagem e ID do erro). */
  r.post('/:tipo/testar', exigir('integracoes.editar'), async (req, res, next) => {
    try {
      const tipo = tipoDe(req);
      try {
        const resultado = await CONECTORES[tipo].coletar(db, req.org);
        registrar(db, req, 'integracao_testada', { recurso: 'integracao', depois: { tipo, ok: true } });
        res.json({ ok: true, resultado, integracao: base.publico(base.ler(db, req.org, tipo), tipo) });
      } catch (err) {
        if (!(err instanceof base.ErroConector)) throw err;
        const x = base.ler(db, req.org, tipo);
        registrar(db, req, 'integracao_testada', { recurso: 'integracao', depois: { tipo, ok: false, estado: err.estado } });
        res.json({ ok: false, estado: err.estado, erro: err.message, erro_id: x?.erro_id ?? null, integracao: base.publico(x, tipo) });
      }
    } catch (err) { next(err); }
  });

  r.post('/:tipo/desabilitar', exigir('integracoes.editar'), (req, res) => {
    const tipo = tipoDe(req);
    db.prepare("UPDATE integracoes SET habilitada = 0, estado = 'desabilitada', proxima_tentativa = NULL WHERE organizacao_id = ? AND tipo = ?").run(req.org, tipo);
    registrar(db, req, 'integracao_desabilitada', { recurso: 'integracao', depois: { tipo } });
    res.json(base.publico(base.ler(db, req.org, tipo), tipo));
  });

  return r;
};
module.exports.CONECTORES = CONECTORES;
