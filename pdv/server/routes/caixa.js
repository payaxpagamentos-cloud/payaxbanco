'use strict';

const { Router } = require('express');
const caixas = require('../lib/caixa');
const { permitir, SUPERVISAO } = require('../auth');
const { registrar } = require('../lib/auditoria');
const { ErroNegocio } = require('../lib/erros');
const { enviarCsv, reais } = require('../lib/csv');
const { hoje } = require('../lib/datas');
const v = require('../lib/validacao');

const OPERA = ['master', 'suporte', 'admin', 'operador'];

/** Caixa do balcão (/api/empresas/:eid/caixa): abertura, sangria, suprimento, fechamento e conferência. */
module.exports = (db) => {
  const r = Router({ mergeParams: true });

  // O caixa aberto de quem está usando o PDV (null quando não há).
  r.get('/meu', (req, res) => {
    const c = caixas.caixaDoOperador(db, req.empresa.id, req.usuario.id);
    res.json({ caixa: c ? caixas.detalhe(db, req.empresa.id, c.id) : null });
  });

  r.get('/', (req, res) => res.json({ caixas: caixas.listar(db, req.empresa.id, req.query) }));

  r.get('/exportar.csv', (req, res) => {
    const lista = caixas.listar(db, req.empresa.id, { ...req.query, limite: 500 });
    enviarCsv(res, `caixas-${req.query.de ?? hoje()}.csv`, [
      ['Caixa', 'Data', 'Loja', 'PDV', 'Operador', 'Situação', 'Fundo', 'Dinheiro', 'PIX', 'Débito', 'Crédito', 'Transferência', 'Outro', 'Recebido', 'Sangrias', 'Suprimentos', 'Diferença'],
      ...lista.map((c) => [c.id, c.data, c.loja_nome, c.pdv_nome, c.operador_nome, c.status, reais(c.fundo_centavos),
        reais(c.resumo.por_forma.dinheiro), reais(c.resumo.por_forma.pix), reais(c.resumo.por_forma.debito), reais(c.resumo.por_forma.credito),
        reais(c.resumo.por_forma.transferencia), reais(c.resumo.por_forma.outro), reais(c.resumo.recebido_centavos),
        reais(c.resumo.sangrias_centavos), reais(c.resumo.suprimentos_centavos), c.diferenca_centavos === null ? '' : reais(c.diferenca_centavos)]),
    ]);
  });

  r.get('/:id', (req, res) => {
    const caixa = caixas.buscar(db, req.empresa.id, req.params.id);
    caixas.exigirAcesso(req.usuario, caixa);
    res.json(caixas.detalhe(db, req.empresa.id, caixa.id));
  });

  r.post('/', permitir(...OPERA), (req, res) => {
    const caixa = caixas.abrir(db, {
      empresa: req.empresa, usuario: req.usuario, pdvId: req.body.pdv_id, fundoCentavos: req.body.fundo_centavos ?? 0, observacao: req.body.observacao,
    });
    registrar(db, req, 'caixa_aberto', { caixa: caixa.id, pdv: caixa.pdv_id, fundo: caixa.fundo_centavos });
    res.status(201).json(caixa);
  });

  r.post('/:id/movimentos', permitir(...OPERA), (req, res) => {
    const caixa = caixas.movimentar(db, {
      empresa: req.empresa, usuario: req.usuario, caixaId: req.params.id, tipo: req.body.tipo, valorCentavos: req.body.valor_centavos, motivo: req.body.motivo,
    });
    registrar(db, req, `caixa_${req.body.tipo}`, { caixa: caixa.id, valor: req.body.valor_centavos, motivo: req.body.motivo });
    res.status(201).json(caixa);
  });

  r.post('/:id/fechar', (req, res) => {
    const caixa = caixas.fechar(db, { empresa: req.empresa, usuario: req.usuario, caixaId: req.params.id, contagem: req.body.contagem ?? {}, observacao: req.body.observacao });
    registrar(db, req, 'caixa_fechado', { caixa: caixa.id, diferenca: caixa.diferenca_centavos });
    res.json(caixa);
  });

  r.post('/:id/conferir', permitir(...SUPERVISAO), (req, res) => {
    const caixa = caixas.conferir(db, { empresa: req.empresa, usuario: req.usuario, caixaId: req.params.id, observacao: req.body.observacao });
    registrar(db, req, 'caixa_conferido', { caixa: caixa.id });
    res.json(caixa);
  });

  // Reabrir um caixa fechado por engano (só supervisão, sempre com motivo e registro na auditoria).
  r.post('/:id/reabrir', permitir(...SUPERVISAO), (req, res) => {
    const caixa = caixas.buscar(db, req.empresa.id, req.params.id);
    if (caixa.status === 'aberto') throw new ErroNegocio('Este caixa já está aberto.', 409);
    if (db.prepare("SELECT 1 FROM caixas WHERE pdv_id = ? AND status = 'aberto'").get(caixa.pdv_id)) throw new ErroNegocio('Já existe outro caixa aberto neste PDV.', 409);
    const motivo = v.texto(req.body.motivo, 'o motivo', 300);
    db.prepare("UPDATE caixas SET status = 'aberto', fechado_em = NULL, fechado_por = NULL, contagem = NULL, diferenca_centavos = NULL, conferido_em = NULL, conferido_por = NULL WHERE id = ?").run(caixa.id);
    registrar(db, req, 'caixa_reaberto', { caixa: caixa.id, motivo });
    res.json(caixas.detalhe(db, req.empresa.id, caixa.id));
  });

  return r;
};
