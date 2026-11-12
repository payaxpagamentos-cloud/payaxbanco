'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const estoque = require('../lib/estoque');
const { naoEncontrado, ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { intervalo } = require('../lib/datas');
const v = require('../lib/validacao');

/** Movimentos de estoque, perdas, acertos e inventário. */
module.exports = (db, { estoque: podeMexer }) => {
  const r = Router();

  r.get('/alertas', (_req, res) => res.json(estoque.alertas(db)));
  r.get('/valor', (_req, res) => res.json(estoque.valorEstoque(db)));

  r.get('/movimentos', (req, res) => {
    const [de, ate] = req.query.de && req.query.ate ? intervalo(v.data(req.query.de, 'a data inicial'), v.data(req.query.ate, 'a data final')) : [null, null];
    res.json(estoque.movimentos(db, {
      produto_id: req.query.produto_id ? Number(req.query.produto_id) : null,
      tipo: req.query.tipo || null,
      de, ate,
      limite: Math.min(Number(req.query.limite) || 200, 1000),
    }));
  });

  /** Entrada avulsa (sem pedido de compra): doação, acerto de recebimento, produção própria. */
  r.post('/entrada', podeMexer, (req, res) => {
    const d = req.body;
    const mov = estoque.movimentar(db, {
      produto_id: v.inteiro(d.produto_id, 'o produto', { min: 1 }),
      tipo: 'entrada',
      qtd_mil: v.quantidade(d.quantidade),
      custo_centavos: v.centavosOpcional(d.custo, 'o custo'),
      validade: v.dataOpcional(d.validade, 'a validade'),
      documento: v.opcional(d.documento, 'o documento', 60),
      observacao: v.opcional(d.observacao, 'a observação', 300) ?? 'Entrada manual',
      usuario_id: req.usuario.id,
    });
    registrar(db, req, 'estoque_entrada', `produto ${d.produto_id}`);
    res.status(201).json(mov);
  });

  /** Perda: vencido, quebrado, consumido na loja. Sai do estoque e entra no relatório de perdas. */
  r.post('/perda', podeMexer, (req, res) => {
    const d = req.body;
    const mov = estoque.movimentar(db, {
      produto_id: v.inteiro(d.produto_id, 'o produto', { min: 1 }),
      tipo: 'perda',
      qtd_mil: v.quantidade(d.quantidade),
      observacao: v.texto(d.motivo, 'o motivo da perda', 300),
      usuario_id: req.usuario.id,
      permitirNegativo: true,
    });
    registrar(db, req, 'estoque_perda', `produto ${d.produto_id}: ${d.motivo}`);
    res.status(201).json(mov);
  });

  /** Acerto direto do saldo para a quantidade contada. */
  r.post('/ajuste', podeMexer, (req, res) => {
    const mov = estoque.ajustarPara(db, {
      produto_id: v.inteiro(req.body.produto_id, 'o produto', { min: 1 }),
      contado_mil: v.quantidade(req.body.contado, 'a quantidade contada', { min: 0 }),
      observacao: v.opcional(req.body.observacao, 'a observação', 300),
      usuario_id: req.usuario.id,
    });
    registrar(db, req, 'estoque_ajuste', `produto ${req.body.produto_id}`);
    res.status(201).json(mov ?? { mensagem: 'O saldo já estava correto.' });
  });

  r.get('/inventarios', (_req, res) => res.json(db.prepare(`SELECT i.*, u.nome AS criado_por_nome,
    (SELECT COUNT(*) FROM inventario_itens x WHERE x.inventario_id = i.id) AS itens
    FROM inventarios i LEFT JOIN usuarios u ON u.id = i.criado_por ORDER BY i.id DESC LIMIT 50`).all()));

  /** Abre a contagem já com o saldo esperado de cada produto (da categoria escolhida ou de todos). */
  r.post('/inventarios', podeMexer, (req, res) => {
    const descricao = v.texto(req.body.descricao, 'a descrição', 120);
    const categoria_id = req.body.categoria_id ? v.inteiro(req.body.categoria_id, 'a categoria', { min: 1 }) : null;
    const inventario = transacao(db, () => {
      const id = Number(db.prepare('INSERT INTO inventarios (descricao, criado_em, criado_por) VALUES (?, ?, ?)').run(descricao, agora(), req.usuario.id).lastInsertRowid);
      const produtos = db.prepare(`SELECT id, estoque_mil FROM produtos WHERE ativo = 1 ${categoria_id ? 'AND categoria_id = ?' : ''}`).all(...(categoria_id ? [categoria_id] : []));
      const ins = db.prepare('INSERT INTO inventario_itens (inventario_id, produto_id, esperado_mil, contado_mil) VALUES (?, ?, ?, ?)');
      for (const p of produtos) ins.run(id, p.id, p.estoque_mil, p.estoque_mil);
      return id;
    });
    res.status(201).json(detalheInventario(inventario));
  });

  const detalheInventario = (id) => {
    const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(id);
    if (!inv) throw naoEncontrado('Inventário');
    return {
      ...inv,
      itens: db.prepare(`SELECT ii.*, p.nome AS produto, p.unidade, p.custo_centavos, (ii.contado_mil - ii.esperado_mil) AS diferenca_mil
        FROM inventario_itens ii JOIN produtos p ON p.id = ii.produto_id WHERE ii.inventario_id = ? ORDER BY p.nome`).all(id),
    };
  };

  r.get('/inventarios/:id', (req, res) => res.json(detalheInventario(Number(req.params.id))));

  /** Lança a contagem de um produto (o que o conferente encontrou na prateleira). */
  r.patch('/inventarios/:id/itens/:produto_id', podeMexer, (req, res) => {
    const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(req.params.id);
    if (!inv) throw naoEncontrado('Inventário');
    if (inv.status !== 'aberto') throw new ErroNegocio('Este inventário já foi encerrado.', 409);
    const contado = v.quantidade(req.body.contado, 'a quantidade contada', { min: 0 });
    const r2 = db.prepare('UPDATE inventario_itens SET contado_mil = ? WHERE inventario_id = ? AND produto_id = ?').run(contado, req.params.id, req.params.produto_id);
    if (!r2.changes) throw naoEncontrado('Item do inventário');
    res.json(detalheInventario(Number(req.params.id)));
  });

  /** Aplica a contagem: cada diferença vira um movimento e o saldo passa a ser o contado. */
  r.post('/inventarios/:id/aplicar', podeMexer, (req, res) => {
    const id = Number(req.params.id);
    const resultado = transacao(db, () => {
      const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(id);
      if (!inv) throw naoEncontrado('Inventário');
      if (inv.status !== 'aberto') throw new ErroNegocio('Este inventário já foi encerrado.', 409);
      let ajustes = 0;
      let diferenca = 0;
      for (const item of db.prepare('SELECT * FROM inventario_itens WHERE inventario_id = ?').all(id)) {
        const p = db.prepare('SELECT estoque_mil, custo_centavos FROM produtos WHERE id = ?').get(item.produto_id);
        if (p.estoque_mil === item.contado_mil) continue;
        diferenca += Math.round(((item.contado_mil - p.estoque_mil) * p.custo_centavos) / 1000);
        estoque.ajustarPara(db, {
          produto_id: item.produto_id, contado_mil: item.contado_mil, tipo: 'inventario',
          observacao: `Inventário #${id}: ${inv.descricao}`, documento: `INV-${id}`, usuario_id: req.usuario.id,
        });
        ajustes++;
      }
      db.prepare("UPDATE inventarios SET status = 'aplicado', aplicado_em = ?, aplicado_por = ? WHERE id = ?").run(agora(), req.usuario.id, id);
      return { ajustes, diferenca_centavos: diferenca };
    });
    registrar(db, req, 'inventario_aplicado', `#${id}: ${resultado.ajustes} ajustes`);
    res.json({ ...detalheInventario(id), ...resultado });
  });

  r.post('/inventarios/:id/cancelar', podeMexer, (req, res) => {
    const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(req.params.id);
    if (!inv) throw naoEncontrado('Inventário');
    if (inv.status !== 'aberto') throw new ErroNegocio('Este inventário já foi encerrado.', 409);
    db.prepare("UPDATE inventarios SET status = 'cancelado' WHERE id = ?").run(req.params.id);
    res.json(detalheInventario(Number(req.params.id)));
  });

  return r;
};
