'use strict';

const express = require('express');
const { auditar } = require('../db');
const { exigirAdminEmpresa } = require('../auth');
const reguaLib = require('../lib/regua');
const custo = require('../lib/custo');
const { hoje, inicioMes } = require('../lib/datas');
const v = require('../lib/validacao');

/** Réguas de mensagens ativas e a conta da Meta. */
module.exports = function rotasRegua(db) {
  const r = express.Router();

  r.get('/', (req, res) => res.json({
    itens: reguaLib.listar(db, req.empresa.id),
    campos: reguaLib.listarCampos(),
    categorias: custo.CATEGORIAS,
    precos: custo.precos(db),
  }));

  r.post('/', exigirAdminEmpresa, (req, res, next) => {
    try {
      const nova = reguaLib.salvar(db, req.empresa.id, req.body ?? {});
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'criou régua', alvo: nova.nome, detalhe: nova.categoria, ip: req.ip });
      res.status(201).json(nova);
    } catch (err) { next(err); }
  });

  r.patch('/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const alterada = reguaLib.salvar(db, req.empresa.id, req.body ?? {}, { id: Number(req.params.id) });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou régua', alvo: alterada.nome, ip: req.ip });
      res.json(alterada);
    } catch (err) { next(err); }
  });

  r.delete('/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const x = reguaLib.buscar(db, req.empresa.id, Number(req.params.id));
      db.prepare('DELETE FROM reguas WHERE id = ?').run(x.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'excluiu régua', alvo: x.nome, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  /** Simulação: nada é enviado. Mostra quantos, quanto custa e quanto a régua economiza. */
  r.post('/:id/simular', async (req, res, next) => {
    try {
      const x = reguaLib.buscar(db, req.empresa.id, Number(req.params.id));
      res.json(await reguaLib.simular(db, req.empresa, x, { referencia: req.body?.data ? v.data(req.body.data, 'a data') : hoje() }));
    } catch (err) { next(err); }
  });

  /** Disparo manual (o automático roda pelo horário da régua). */
  r.post('/:id/executar', exigirAdminEmpresa, async (req, res, next) => {
    try {
      const x = reguaLib.buscar(db, req.empresa.id, Number(req.params.id));
      const resultado = await reguaLib.executar(db, req.empresa, x, {
        referencia: req.body?.data ? v.data(req.body.data, 'a data') : hoje(), usuario: req.usuario,
      });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'disparou a régua', alvo: x.nome, detalhe: resultado, ip: req.ip });
      res.json(resultado);
    } catch (err) { next(err); }
  });

  r.get('/:id/historico', (req, res, next) => {
    try { res.json(reguaLib.historico(db, req.empresa.id, Number(req.params.id))); } catch (err) { next(err); }
  });

  /** A conta da Meta: o que foi gasto, o que deixou de ser e a projeção do mês. */
  r.get('/custos/resumo', (req, res, next) => {
    try {
      const de = req.query.de ? v.data(req.query.de, 'a data inicial') : inicioMes();
      const ate = req.query.ate ? v.data(req.query.ate, 'a data final') : hoje();
      res.json({
        ...custo.resumo(db, req.empresa.id, { de, ate }),
        projecao: custo.projecao(db, req.empresa.id),
        por_regua: db.prepare(`SELECT r.id, r.nome, r.categoria,
            SUM(CASE WHEN d.status = 'enviado' THEN 1 ELSE 0 END) AS enviados,
            SUM(CASE WHEN d.status = 'pulado' THEN 1 ELSE 0 END) AS pulados,
            SUM(CASE WHEN d.status = 'enviado' AND d.categoria = 'servico' THEN 1 ELSE 0 END) AS pela_janela,
            COALESCE(SUM(d.custo_milesimos), 0) AS custo_milesimos,
            COALESCE(SUM(d.economia_milesimos), 0) AS economia_milesimos
          FROM reguas r LEFT JOIN disparos d ON d.regua_id = r.id AND d.criado_em >= ?
          WHERE r.empresa_id = ? GROUP BY r.id ORDER BY custo_milesimos DESC`)
          .all(require('../lib/datas').intervalo(de, ate)[0], req.empresa.id),
      });
    } catch (err) { next(err); }
  });

  return r;
};
