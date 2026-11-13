'use strict';

const { Router } = require('express');
const caixa = require('../lib/caixa');
const { registrar } = require('../lib/auditoria');
const { intervalo } = require('../lib/datas');
const v = require('../lib/validacao');

/** Abertura, conferência e fechamento do caixa, com sangrias e suprimentos. */
module.exports = (db, { gestao }) => {
  const r = Router();

  /** O caixa do operador logado (null quando ele ainda não abriu). */
  r.get('/atual', (req, res) => {
    const aberto = caixa.abertoDo(db, req.usuario.id);
    res.json(aberto ? caixa.resumo(db, aberto.id) : null);
  });

  r.get('/abertos', gestao, (_req, res) => res.json(caixa.abertos(db).map((c) => caixa.resumo(db, c.id))));

  r.get('/historico', (req, res) => {
    const [de, ate] = req.query.de && req.query.ate ? intervalo(v.data(req.query.de, 'a data inicial'), v.data(req.query.ate, 'a data final')) : [null, null];
    res.json(caixa.historico(db, { de, ate }));
  });

  r.get('/:id', (req, res) => res.json(caixa.resumo(db, Number(req.params.id))));

  r.post('/abrir', (req, res) => {
    const c = caixa.abrirCaixa(db, {
      usuario_id: req.usuario.id,
      abertura_centavos: v.centavosOpcional(req.body.abertura, 'o valor de abertura') ?? 0,
      observacao: v.opcional(req.body.observacao, 'a observação', 300),
    });
    registrar(db, req, 'caixa_aberto', `#${c.id}`);
    res.status(201).json(caixa.resumo(db, c.id));
  });

  r.post('/:id/movimento', (req, res) => {
    const mov = caixa.movimentar(db, Number(req.params.id), {
      tipo: v.opcao(req.body.tipo, 'o tipo', ['suprimento', 'sangria']),
      valor_centavos: v.centavos(req.body.valor, 'o valor', { min: 0.01 }),
      motivo: v.texto(req.body.motivo, 'o motivo', 200),
      usuario_id: req.usuario.id,
    });
    registrar(db, req, `caixa_${mov.tipo}`, `#${req.params.id}: ${req.body.motivo}`);
    res.status(201).json(caixa.resumo(db, Number(req.params.id)));
  });

  r.post('/:id/fechar', (req, res) => {
    const resumo = caixa.fechar(db, Number(req.params.id), {
      informado_centavos: v.centavos(req.body.informado, 'o valor conferido'),
      observacao: v.opcional(req.body.observacao, 'a observação', 300),
      usuario_id: req.usuario.id,
    });
    registrar(db, req, 'caixa_fechado', `#${req.params.id} diferença ${resumo.caixa.diferenca_centavos}`);
    res.json(resumo);
  });

  return r;
};
