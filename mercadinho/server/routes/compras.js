'use strict';

const { Router } = require('express');
const compras = require('../lib/compras');
const produtosLib = require('../lib/produtos');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');

/** Pedidos ao fornecedor, recebimento da mercadoria e sugestão de reposição. */
module.exports = (db, { gestao }) => {
  const r = Router();
  const itemDoCorpo = (i) => ({
    produto_id: v.inteiro(i.produto_id, 'o produto', { min: 1 }),
    qtd_mil: v.quantidade(i.quantidade),
    custo_centavos: v.centavosOpcional(i.custo, 'o custo'),
    validade: v.dataOpcional(i.validade, 'a validade'),
    preco_sugerido_centavos: v.centavosOpcional(i.preco_venda, 'o preço de venda'),
  });

  r.get('/sugestao', (_req, res) => res.json(compras.sugestao(db)));

  r.get('/', (req, res) => res.json(compras.listar(db, {
    status: req.query.status || null,
    fornecedor_id: req.query.fornecedor_id ? Number(req.query.fornecedor_id) : null,
  })));

  r.get('/:id', (req, res) => res.json(compras.obter(db, Number(req.params.id))));

  r.post('/', (req, res) => {
    const d = req.body;
    const compra = compras.criar(db, {
      fornecedor_id: v.inteiro(d.fornecedor_id, 'o fornecedor', { min: 1 }),
      numero_nota: v.opcional(d.numero_nota, 'o número da nota', 40),
      previsao: v.dataOpcional(d.previsao, 'a previsão de entrega'),
      parcelas: v.inteiro(d.parcelas ?? 1, 'as parcelas', { min: 1, max: 12 }),
      frete_centavos: v.centavosOpcional(d.frete, 'o frete') ?? 0,
      desconto_centavos: v.centavosOpcional(d.desconto, 'o desconto') ?? 0,
      observacao: v.opcional(d.observacao, 'a observação', 500),
      itens: (Array.isArray(d.itens) ? d.itens : []).map(itemDoCorpo),
      usuario_id: req.usuario.id,
    });
    registrar(db, req, 'compra_criada', `#${compra.id}`);
    res.status(201).json(compra);
  });

  r.patch('/:id', (req, res) => {
    const d = req.body;
    const campos = {};
    if (d.numero_nota !== undefined) campos.numero_nota = v.opcional(d.numero_nota, 'o número da nota', 40);
    if (d.previsao !== undefined) campos.previsao = v.dataOpcional(d.previsao, 'a previsão de entrega');
    if (d.parcelas !== undefined) campos.parcelas = v.inteiro(d.parcelas, 'as parcelas', { min: 1, max: 12 });
    if (d.frete !== undefined) campos.frete_centavos = v.centavosOpcional(d.frete, 'o frete') ?? 0;
    if (d.desconto !== undefined) campos.desconto_centavos = v.centavosOpcional(d.desconto, 'o desconto') ?? 0;
    if (d.observacao !== undefined) campos.observacao = v.opcional(d.observacao, 'a observação', 500);
    res.json(compras.atualizar(db, Number(req.params.id), campos));
  });

  r.post('/:id/itens', (req, res) => res.status(201).json(compras.adicionarItem(db, Number(req.params.id), itemDoCorpo(req.body))));
  r.delete('/:id/itens/:item', (req, res) => res.json(compras.removerItem(db, Number(req.params.id), Number(req.params.item))));
  r.post('/:id/enviar', (req, res) => res.json(compras.enviar(db, Number(req.params.id))));

  /** Recebimento: confere quantidades e custos, dá entrada no estoque e abre as contas a pagar. */
  r.post('/:id/receber', (req, res) => {
    const itens = (Array.isArray(req.body.itens) ? req.body.itens : []).map((i) => ({
      item_id: v.inteiro(i.item_id, 'o item', { min: 1 }),
      recebido_mil: i.recebido === undefined ? null : v.quantidade(i.recebido, 'a quantidade recebida', { min: 0 }),
      custo_centavos: v.centavosOpcional(i.custo, 'o custo'),
      validade: v.dataOpcional(i.validade, 'a validade'),
      preco_sugerido_centavos: v.centavosOpcional(i.preco_venda, 'o preço de venda'),
    }));
    const compra = compras.receber(db, Number(req.params.id), {
      itens, numero_nota: v.opcional(req.body.numero_nota, 'o número da nota', 40), usuario_id: req.usuario.id,
    });
    registrar(db, req, 'compra_recebida', `#${compra.id} total ${compra.total_centavos}`);
    res.json(compra);
  });

  r.post('/:id/cancelar', gestao, (req, res) => res.json(compras.cancelar(db, Number(req.params.id), v.opcional(req.body.motivo, 'o motivo', 300))));

  /** Gera um rascunho de pedido a partir da sugestão de reposição de um fornecedor. */
  r.post('/sugestao/:fornecedor_id', (req, res) => {
    const fornecedor_id = v.inteiro(req.params.fornecedor_id, 'o fornecedor', { min: 1 });
    const grupo = compras.sugestao(db).find((g) => g.fornecedor_id === fornecedor_id);
    if (!grupo) throw new (require('../lib/erros').ErroNegocio)('Não há itens para repor deste fornecedor.', 409);
    const compra = compras.criar(db, {
      fornecedor_id,
      observacao: 'Pedido gerado pela sugestão de reposição',
      itens: grupo.itens.map((i) => ({ produto_id: i.id, qtd_mil: i.sugerido_mil, custo_centavos: i.custo_centavos, validade: null, preco_sugerido_centavos: null })),
      usuario_id: req.usuario.id,
      parcelas: 1,
      frete_centavos: 0,
      desconto_centavos: 0,
      previsao: null,
      numero_nota: null,
    });
    res.status(201).json(compra);
  });

  /** Preço de venda sugerido para o item que está sendo recebido. */
  r.get('/sugerir-preco/:custo', (req, res) => {
    const custo = v.inteiro(req.params.custo, 'o custo', { min: 0 });
    res.json({ preco_centavos: produtosLib.precoSugerido(db, custo) });
  });

  return r;
};
