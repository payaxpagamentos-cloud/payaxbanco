'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const express = require('express');
const produtos = require('../lib/produtos');
const fotos = require('../lib/fotos');
const { naoEncontrado, ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');

/** Produtos, categorias e fornecedores: o cadastro que alimenta o PDV e as compras. */
module.exports = (db, { estoque }) => {
  const r = Router();

  r.get('/categorias', (_req, res) => res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM produtos p WHERE p.categoria_id = c.id AND p.ativo = 1) AS produtos
    FROM categorias c ORDER BY c.nome`).all()));

  r.post('/categorias', estoque, (req, res) => {
    const nome = v.texto(req.body.nome, 'o nome da categoria', 60);
    const cor = v.opcional(req.body.cor, 'a cor', 20) ?? '#6E8BFF';
    const id = Number(db.prepare('INSERT INTO categorias (nome, cor) VALUES (?, ?)').run(nome, cor).lastInsertRowid);
    res.status(201).json(db.prepare('SELECT * FROM categorias WHERE id = ?').get(id));
  });

  r.patch('/categorias/:id', estoque, (req, res) => {
    const campos = {};
    if (req.body.nome !== undefined) campos.nome = v.texto(req.body.nome, 'o nome da categoria', 60);
    if (req.body.cor !== undefined) campos.cor = v.texto(req.body.cor, 'a cor', 20);
    if (req.body.ativa !== undefined) campos.ativa = req.body.ativa ? 1 : 0;
    const colunas = Object.keys(campos);
    if (colunas.length) db.prepare(`UPDATE categorias SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((c) => campos[c]), req.params.id);
    res.json(db.prepare('SELECT * FROM categorias WHERE id = ?').get(req.params.id));
  });

  r.get('/fornecedores', (req, res) => {
    const busca = String(req.query.busca ?? '').trim();
    res.json(db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM produtos p WHERE p.fornecedor_id = f.id) AS produtos,
      (SELECT COALESCE(SUM(l.valor_centavos), 0) FROM lancamentos l WHERE l.fornecedor_id = f.id AND l.tipo = 'pagar' AND l.status = 'aberto') AS a_pagar_centavos
      FROM fornecedores f ${busca ? 'WHERE f.nome LIKE ?' : ''} ORDER BY f.ativo DESC, f.nome`).all(...(busca ? [`%${busca}%`] : [])));
  });

  const dadosFornecedor = (d, novo) => {
    const campos = {};
    if (novo || d.nome !== undefined) campos.nome = v.texto(d.nome, 'o nome do fornecedor', 120);
    if (novo || d.cnpj !== undefined) {
      const cnpj = v.opcional(d.cnpj, 'o CNPJ', 18);
      if (cnpj) v.exigir(v.cnpjValido(cnpj), 'CNPJ inválido.');
      campos.cnpj = cnpj ? v.digitos(cnpj) : null;
    }
    if (novo || d.contato !== undefined) campos.contato = v.opcional(d.contato, 'o contato', 120);
    if (novo || d.telefone !== undefined) campos.telefone = v.telefoneOpcional(d.telefone);
    if (novo || d.email !== undefined) campos.email = v.emailOpcional(d.email);
    if (novo || d.prazo_entrega_dias !== undefined) campos.prazo_entrega_dias = v.inteiro(d.prazo_entrega_dias ?? 3, 'o prazo de entrega', { min: 0, max: 180 });
    if (novo || d.prazo_pagamento_dias !== undefined) campos.prazo_pagamento_dias = v.inteiro(d.prazo_pagamento_dias ?? 28, 'o prazo de pagamento', { min: 0, max: 365 });
    if (novo || d.observacao !== undefined) campos.observacao = v.opcional(d.observacao, 'a observação', 400);
    if (d.ativo !== undefined) campos.ativo = d.ativo ? 1 : 0;
    return campos;
  };

  r.post('/fornecedores', estoque, (req, res) => {
    const campos = dadosFornecedor(req.body, true);
    const colunas = Object.keys(campos);
    const id = Number(db.prepare(`INSERT INTO fornecedores (${colunas.join(', ')}, criado_em) VALUES (${colunas.map(() => '?').join(', ')}, ?)`)
      .run(...colunas.map((c) => campos[c]), agora()).lastInsertRowid);
    registrar(db, req, 'fornecedor_criado', campos.nome);
    res.status(201).json(db.prepare('SELECT * FROM fornecedores WHERE id = ?').get(id));
  });

  r.patch('/fornecedores/:id', estoque, (req, res) => {
    if (!db.prepare('SELECT 1 FROM fornecedores WHERE id = ?').get(req.params.id)) throw naoEncontrado('Fornecedor');
    const campos = dadosFornecedor(req.body, false);
    const colunas = Object.keys(campos);
    if (colunas.length) db.prepare(`UPDATE fornecedores SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((c) => campos[c]), req.params.id);
    res.json(db.prepare('SELECT * FROM fornecedores WHERE id = ?').get(req.params.id));
  });

  r.get('/', (req, res) => res.json(produtos.listar(db, {
    busca: req.query.busca,
    categoria_id: req.query.categoria_id ? Number(req.query.categoria_id) : null,
    fornecedor_id: req.query.fornecedor_id ? Number(req.query.fornecedor_id) : null,
    situacao: req.query.situacao ?? 'ativos',
    ordem: req.query.ordem,
  })));

  /** Busca do PDV (código de barras ou nome). */
  r.get('/busca', (req, res) => res.json(produtos.buscarParaVenda(db, req.query.termo)));

  /** Preço sugerido a partir do custo, com a margem padrão da loja. */
  r.get('/sugerir-preco', (req, res) => {
    const custo = v.centavos(req.query.custo, 'o custo');
    res.json({ custo_centavos: custo, preco_centavos: produtos.precoSugerido(db, custo) });
  });

  r.get('/:id', (req, res) => {
    const p = produtos.obter(db, req.params.id);
    if (!p) throw naoEncontrado('Produto');
    res.json({
      ...p,
      movimentos: require('../lib/estoque').movimentos(db, { produto_id: p.id, limite: 30 }),
      lotes: db.prepare('SELECT * FROM lotes WHERE produto_id = ? AND qtd_mil > 0 ORDER BY validade').all(p.id),
      vendas_30_dias: db.prepare(`SELECT COALESCE(SUM(i.qtd_mil), 0) AS qtd_mil, COALESCE(SUM(i.total_centavos), 0) AS total_centavos
        FROM venda_itens i JOIN vendas v ON v.id = i.venda_id WHERE i.produto_id = ? AND v.status = 'paga' AND v.fechada_em >= datetime('now', '-30 days')`).get(p.id),
    });
  });

  r.post('/', estoque, (req, res) => {
    const p = produtos.criar(db, req.body, req.usuario);
    registrar(db, req, 'produto_criado', p.nome);
    res.status(201).json(p);
  });

  r.patch('/:id', estoque, (req, res) => {
    const p = produtos.atualizar(db, Number(req.params.id), req.body);
    registrar(db, req, 'produto_alterado', p.nome);
    res.json(p);
  });

  /**
   * Foto do produto. O navegador manda a imagem já reduzida, como arquivo mesmo (sem JSON no meio),
   * e o servidor confere os primeiros bytes antes de gravar — o cabeçalho enviado não é prova de nada.
   */
  r.post('/:id/foto', estoque, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '3mb' }), (req, res) => {
    const id = v.inteiro(req.params.id, 'o produto', { min: 1 });
    const atual = db.prepare('SELECT foto FROM produtos WHERE id = ?').get(id);
    if (!atual) throw naoEncontrado('Produto');
    const nome = fotos.guardar(req.body, id, atual.foto);
    db.prepare('UPDATE produtos SET foto = ?, atualizado_em = ? WHERE id = ?').run(nome, agora(), id);
    registrar(db, req, 'produto_foto', `#${id}`);
    res.status(201).json({ foto: nome });
  });

  r.delete('/:id/foto', estoque, (req, res) => {
    const id = v.inteiro(req.params.id, 'o produto', { min: 1 });
    const atual = db.prepare('SELECT foto FROM produtos WHERE id = ?').get(id);
    if (!atual) throw naoEncontrado('Produto');
    if (atual.foto) fotos.apagar(atual.foto);
    db.prepare('UPDATE produtos SET foto = NULL, atualizado_em = ? WHERE id = ?').run(agora(), id);
    res.json({ foto: null });
  });

  /** Reajuste de preço em lote (por categoria ou por fornecedor), com percentual positivo ou negativo. */
  r.post('/reajuste', estoque, (req, res) => {
    const percentual = v.numero(req.body.percentual, 'o percentual', { min: -90, max: 300 });
    const categoria_id = req.body.categoria_id ? v.inteiro(req.body.categoria_id, 'a categoria', { min: 1 }) : null;
    const fornecedor_id = req.body.fornecedor_id ? v.inteiro(req.body.fornecedor_id, 'o fornecedor', { min: 1 }) : null;
    if (!categoria_id && !fornecedor_id) throw new ErroNegocio('Escolha uma categoria ou um fornecedor para o reajuste.', 422);
    const alvo = produtos.listar(db, { categoria_id, fornecedor_id, situacao: 'ativos', limite: 5000 });
    const fator = 1 + percentual / 100;
    for (const p of alvo) {
      db.prepare('UPDATE produtos SET preco_centavos = ?, atualizado_em = ? WHERE id = ?').run(Math.max(0, Math.round(p.preco_centavos * fator)), agora(), p.id);
    }
    registrar(db, req, 'reajuste_precos', `${alvo.length} produtos em ${percentual}%`);
    res.json({ produtos: alvo.length, percentual });
  });

  return r;
};
