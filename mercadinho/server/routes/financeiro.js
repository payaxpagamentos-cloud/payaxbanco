'use strict';

const { Router } = require('express');
const financeiro = require('../lib/financeiro');
const { registrar } = require('../lib/auditoria');
const { hoje, competencia: competenciaDe, somarDias } = require('../lib/datas');
const v = require('../lib/validacao');

/** Contas a pagar e a receber, fluxo de caixa e DRE. */
module.exports = (db) => {
  const r = Router();

  r.get('/resumo', (_req, res) => res.json(financeiro.resumo(db)));
  r.get('/categorias', (_req, res) => res.json(financeiro.CATEGORIAS));

  r.get('/lancamentos', (req, res) => res.json(financeiro.listar(db, {
    tipo: req.query.tipo || null,
    status: req.query.status || null,
    categoria: req.query.categoria || null,
    fornecedor_id: req.query.fornecedor_id ? Number(req.query.fornecedor_id) : null,
    morador_id: req.query.morador_id ? Number(req.query.morador_id) : null,
    de: req.query.de ? v.data(req.query.de, 'a data inicial') : null,
    ate: req.query.ate ? v.data(req.query.ate, 'a data final') : null,
    vencidos: req.query.vencidos === '1',
  })));

  r.post('/lancamentos', (req, res) => {
    const d = req.body;
    const l = financeiro.criar(db, {
      tipo: v.opcao(d.tipo, 'o tipo', ['pagar', 'receber']),
      descricao: v.texto(d.descricao, 'a descrição', 200),
      categoria: v.opcional(d.categoria, 'a categoria', 60) ?? 'Outros',
      fornecedor_id: d.fornecedor_id ? v.inteiro(d.fornecedor_id, 'o fornecedor', { min: 1 }) : null,
      morador_id: d.morador_id ? v.inteiro(d.morador_id, 'o morador', { min: 1 }) : null,
      valor_centavos: v.centavos(d.valor, 'o valor', { min: 0.01 }),
      vencimento: v.data(d.vencimento, 'o vencimento'),
      observacao: v.opcional(d.observacao, 'a observação', 500),
    }, req.usuario.id);
    registrar(db, req, 'lancamento_criado', `${l.tipo} ${l.descricao}`);
    res.status(201).json(l);
  });

  r.patch('/lancamentos/:id', (req, res) => {
    const d = req.body;
    const campos = {};
    if (d.descricao !== undefined) campos.descricao = v.texto(d.descricao, 'a descrição', 200);
    if (d.categoria !== undefined) campos.categoria = v.texto(d.categoria, 'a categoria', 60);
    if (d.valor !== undefined) campos.valor_centavos = v.centavos(d.valor, 'o valor', { min: 0.01 });
    if (d.vencimento !== undefined) campos.vencimento = v.data(d.vencimento, 'o vencimento');
    if (d.observacao !== undefined) campos.observacao = v.opcional(d.observacao, 'a observação', 500);
    res.json(financeiro.atualizar(db, Number(req.params.id), campos));
  });

  r.post('/lancamentos/:id/baixar', (req, res) => {
    const l = financeiro.baixar(db, Number(req.params.id), {
      pago_em: req.body.pago_em ? v.data(req.body.pago_em, 'a data do pagamento') : hoje(),
      pago_centavos: v.centavosOpcional(req.body.valor, 'o valor pago'),
      forma: v.opcional(req.body.forma, 'a forma', 30) ?? 'dinheiro',
      usuario_id: req.usuario.id,
    });
    registrar(db, req, 'lancamento_baixado', `#${l.id} ${l.descricao}`);
    res.json(l);
  });

  r.post('/lancamentos/:id/estornar', (req, res) => res.json(financeiro.estornar(db, Number(req.params.id))));
  r.post('/lancamentos/:id/cancelar', (req, res) => res.json(financeiro.cancelar(db, Number(req.params.id), v.opcional(req.body.motivo, 'o motivo', 300))));

  r.get('/fluxo', (req, res) => res.json(financeiro.fluxo(db, {
    de: req.query.de ? v.data(req.query.de, 'a data inicial') : somarDias(hoje(), -29),
    ate: req.query.ate ? v.data(req.query.ate, 'a data final') : hoje(),
  })));

  r.get('/dre', (req, res) => res.json(financeiro.dre(db, req.query.competencia ? v.competencia(req.query.competencia) : competenciaDe())));

  return r;
};
