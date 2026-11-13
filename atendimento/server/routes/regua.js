'use strict';

const express = require('express');
const { auditar } = require('../db');
const { exigirAdminEmpresa } = require('../auth');
const reguaLib = require('../lib/regua');
const custo = require('../lib/custo');
const orcamento = require('../lib/orcamento');
const pendencias = require('../lib/pendencias');
const fechamento = require('../lib/fechamento');
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

  // ---------- Sala de espera da janela ----------
  /** O que está esperando o cliente escrever em vez de virar template pago. */
  r.get('/pendencias', (req, res, next) => {
    try { res.json(pendencias.resumo(db, req.empresa.id)); } catch (err) { next(err); }
  });

  /** Paga agora o que já venceu o prazo de espera (o agendador faz isso de hora em hora). */
  r.post('/pendencias/varrer', exigirAdminEmpresa, async (req, res, next) => {
    try {
      const resultado = await reguaLib.pagarVencidas(db);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'varreu a sala de espera', detalhe: resultado, ip: req.ip });
      res.json(resultado);
    } catch (err) { next(err); }
  });

  // ---------- Orçamento do mês ----------
  r.get('/orcamento', (req, res, next) => {
    try {
      res.json({ ...orcamento.estado(db, req.empresa.id), avisos: orcamento.avisos(db, req.empresa.id) });
    } catch (err) { next(err); }
  });

  r.put('/orcamento', exigirAdminEmpresa, (req, res, next) => {
    try {
      const estado = orcamento.definir(db, req.empresa.id, req.body ?? {});
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'definiu o orçamento da Meta',
        detalhe: { total: estado.orcamento_milesimos, marketing: estado.orcamento_marketing_milesimos }, ip: req.ip });
      res.json(estado);
    } catch (err) { next(err); }
  });

  // ---------- Fechamento mensal e conferência com a fatura ----------
  r.get('/fechamentos', (req, res, next) => {
    try { res.json(fechamento.serie(db, req.empresa.id, { meses: Number(req.query.meses) || 12 })); } catch (err) { next(err); }
  });

  r.post('/fechamentos/:mes/fechar', exigirAdminEmpresa, (req, res, next) => {
    try {
      const f = fechamento.fechar(db, req.empresa.id, String(req.params.mes));
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'fechou o mês da conta da Meta', alvo: f.mes, detalhe: { gasto_milesimos: f.gasto_milesimos }, ip: req.ip });
      res.json(f);
    } catch (err) { next(err); }
  });

  /** A gestão lança o valor da fatura da Meta; o sistema mostra a diferença contra o que contou. */
  r.post('/fechamentos/:mes/fatura', exigirAdminEmpresa, (req, res, next) => {
    try {
      const f = fechamento.conferir(db, req.empresa.id, String(req.params.mes), {
        valor_centavos: req.body?.valor_centavos, observacao: req.body?.observacao, usuario: req.usuario,
      });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'lançou a fatura da Meta', alvo: f.mes,
        detalhe: { fatura_centavos: f.fatura_meta_centavos, diferenca_centavos: f.diferenca_centavos }, ip: req.ip });
      res.json(f);
    } catch (err) { next(err); }
  });

  r.post('/fechamentos/:mes/reabrir', exigirAdminEmpresa, (req, res, next) => {
    try {
      const f = fechamento.reabrir(db, req.empresa.id, String(req.params.mes));
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'reabriu o mês da conta da Meta', alvo: f.mes, ip: req.ip });
      res.json(f);
    } catch (err) { next(err); }
  });

  return r;
};
