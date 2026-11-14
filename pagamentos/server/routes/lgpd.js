'use strict';

/* LGPD (Backoffice): pedidos dos titulares, incidentes, inventário, retenção e encarregado. Só o administrador. */
const express = require('express');
const { exigir } = require('../auth');
const lgpd = require('../lib/lgpd');
const auditoria = require('../lib/auditoria');

module.exports = (db) => {
  const r = express.Router();
  const ver = exigir('lgpd.ver', '*');
  const atender = exigir('lgpd.atender', '*');

  r.get('/', ver, (_req, res) => res.json({ resumo: lgpd.resumo(db), inventario: lgpd.INVENTARIO, direitos: lgpd.DIREITOS }));

  // ---------------------------------------------------------------- Pedidos
  r.get('/pedidos', ver, (req, res) => res.json({ itens: lgpd.listarPedidos(db, { abertos: req.query.abertos === '1' }) }));
  r.get('/pedidos/:id', ver, (req, res) => res.json(lgpd.pedido(db, Number(req.params.id))));

  r.post('/pedidos/:id/identidade', atender, (req, res) => {
    const out = lgpd.verificarIdentidade(db, Number(req.params.id), req.body ?? {}, req.usuario);
    auditoria.registrar(db, req, { acao: 'lgpd.identidade_conferida', entidade: 'lgpd_pedido', entidade_id: out.id });
    res.json(out);
  });

  /** Relatório do que guardamos do titular, para anexar à resposta de acesso. */
  r.get('/pedidos/:id/dados', atender, (req, res) => {
    const p = lgpd.pedido(db, Number(req.params.id));
    if (p.situacao === 'recebido') return res.status(409).json({ erro: 'Confira a identidade do titular antes de gerar o relatório.' });
    auditoria.registrar(db, req, { acao: 'lgpd.relatorio_gerado', entidade: 'lgpd_pedido', entidade_id: p.id });
    res.json(lgpd.dadosDoTitular(db, p.titular_documento));
  });

  r.post('/pedidos/:id/responder', atender, (req, res) => {
    const out = lgpd.responder(db, Number(req.params.id), req.body ?? {}, req.usuario);
    auditoria.registrar(db, req, { acao: 'lgpd.respondido', entidade: 'lgpd_pedido', entidade_id: out.id, depois: { situacao: out.situacao } });
    res.json(out);
  });

  // ---------------------------------------------------------------- Incidentes
  r.get('/incidentes', ver, (_req, res) => res.json({ itens: lgpd.listarIncidentes(db) }));
  r.post('/incidentes', atender, (req, res) => {
    const out = lgpd.registrarIncidente(db, req.body ?? {}, req.usuario);
    auditoria.registrar(db, req, { acao: 'lgpd.incidente_registrado', entidade: 'lgpd_incidente', entidade_id: out.id, depois: { risco: out.risco } });
    res.status(201).json(out);
  });
  r.patch('/incidentes/:id', atender, (req, res) => {
    const out = lgpd.atualizarIncidente(db, Number(req.params.id), req.body ?? {});
    auditoria.registrar(db, req, { acao: 'lgpd.incidente_atualizado', entidade: 'lgpd_incidente', entidade_id: out.id,
      depois: { risco: out.risco, anpd: Boolean(out.anpd_comunicada_em), titulares: Boolean(out.titulares_comunicados_em), encerrado: Boolean(out.encerrado_em) } });
    res.json(out);
  });

  // ---------------------------------------------------------------- Encarregado e retenção
  r.put('/encarregado', atender, (req, res) => {
    const out = lgpd.gravarEncarregado(db, req.body ?? {});
    auditoria.registrar(db, req, { acao: 'lgpd.encarregado', entidade: 'lgpd', depois: out });
    res.json(out);
  });

  r.post('/retencao', atender, (req, res) => {
    const out = lgpd.aplicarRetencao(db);
    auditoria.registrar(db, req, { acao: 'lgpd.retencao', entidade: 'lgpd', depois: out });
    res.json(out);
  });

  return r;
};
