'use strict';

const { agora, lerConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje, somarDias } = require('./datas');

const TIPOS_ENTRADA = ['entrada', 'devolucao'];

/** Quantidade em milésimos formatada para as mensagens (1500 -> "1,5"). */
const qtdTexto = (mil) => (mil / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/**
 * Custo médio ponderado: o custo do produto acompanha o preço pago em cada entrada.
 * Com saldo zerado ou negativo, o custo passa a ser o da entrada (não há o que ponderar).
 */
function novoCustoMedio({ saldoAtual, custoAtual, qtdEntrada, custoEntrada }) {
  if (custoEntrada <= 0) return custoAtual;
  if (saldoAtual <= 0) return custoEntrada;
  const total = saldoAtual * custoAtual + qtdEntrada * custoEntrada;
  return Math.round(total / (saldoAtual + qtdEntrada));
}

/** Entrada de lote com validade (só para produtos que controlam validade). */
function entrarLote(db, produto_id, qtd_mil, validade, custo_centavos) {
  const existente = db.prepare('SELECT id, qtd_mil FROM lotes WHERE produto_id = ? AND validade = ?').get(produto_id, validade);
  if (existente) db.prepare('UPDATE lotes SET qtd_mil = qtd_mil + ?, custo_centavos = ? WHERE id = ?').run(qtd_mil, custo_centavos, existente.id);
  else db.prepare('INSERT INTO lotes (produto_id, validade, qtd_mil, custo_centavos, criado_em) VALUES (?, ?, ?, ?, ?)').run(produto_id, validade, qtd_mil, custo_centavos, agora());
}

/** Saída pelos lotes que vencem primeiro (PEPS). Sobra sem lote é ignorada: o saldo do produto continua sendo a verdade. */
function baixarLotes(db, produto_id, qtd_mil) {
  let restante = qtd_mil;
  const lotes = db.prepare('SELECT id, qtd_mil FROM lotes WHERE produto_id = ? AND qtd_mil > 0 ORDER BY validade, id').all(produto_id);
  for (const lote of lotes) {
    if (restante <= 0) break;
    const usar = Math.min(lote.qtd_mil, restante);
    db.prepare('UPDATE lotes SET qtd_mil = qtd_mil - ? WHERE id = ?').run(usar, lote.id);
    restante -= usar;
  }
  db.prepare('DELETE FROM lotes WHERE produto_id = ? AND qtd_mil <= 0').run(produto_id);
}

/**
 * Único caminho para mexer no estoque: atualiza o saldo do produto, grava o movimento com o saldo resultante,
 * cuida dos lotes de validade e, nas entradas, recalcula o custo médio.
 * qtd_mil é sempre positivo; o tipo define se entra ou sai.
 */
function movimentar(db, { produto_id, tipo, qtd_mil, custo_centavos = null, validade = null, documento = null, observacao = null, venda_id = null, compra_id = null, usuario_id = null, permitirNegativo = null }) {
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(produto_id);
  if (!produto) throw naoEncontrado('Produto');
  if (!Number.isInteger(qtd_mil) || qtd_mil <= 0) throw new ErroNegocio('Quantidade inválida.', 422);

  const entra = TIPOS_ENTRADA.includes(tipo);
  const delta = entra ? qtd_mil : -qtd_mil;
  const saldo = produto.estoque_mil + delta;
  const negativoLiberado = permitirNegativo ?? lerConfig(db).permitir_estoque_negativo;
  if (!entra && saldo < 0 && !negativoLiberado) {
    throw new ErroNegocio(`Estoque insuficiente de ${produto.nome}: restam ${qtdTexto(produto.estoque_mil)} ${produto.unidade}.`, 409);
  }

  let custo = produto.custo_centavos;
  if (entra && custo_centavos !== null) {
    custo = novoCustoMedio({ saldoAtual: produto.estoque_mil, custoAtual: produto.custo_centavos, qtdEntrada: qtd_mil, custoEntrada: custo_centavos });
  }
  db.prepare('UPDATE produtos SET estoque_mil = ?, custo_centavos = ?, atualizado_em = ? WHERE id = ?').run(saldo, custo, agora(), produto_id);

  if (produto.controla_validade) {
    if (entra && validade) entrarLote(db, produto_id, qtd_mil, validade, custo_centavos ?? produto.custo_centavos);
    if (!entra) baixarLotes(db, produto_id, qtd_mil);
  }

  const mov = db.prepare(`INSERT INTO estoque_mov (produto_id, tipo, qtd_mil, saldo_mil, custo_centavos, documento, observacao, venda_id, compra_id, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(produto_id, tipo, delta, saldo, custo_centavos ?? produto.custo_centavos, documento, observacao, venda_id, compra_id, usuario_id, agora());
  return { id: Number(mov.lastInsertRowid), saldo_mil: saldo, custo_centavos: custo };
}

/** Acerta o saldo do produto para a quantidade contada (diferença lançada como ajuste ou inventário). */
function ajustarPara(db, { produto_id, contado_mil, tipo = 'ajuste', observacao = null, usuario_id = null, documento = null }) {
  const produto = db.prepare('SELECT estoque_mil FROM produtos WHERE id = ?').get(produto_id);
  if (!produto) throw naoEncontrado('Produto');
  const diferenca = contado_mil - produto.estoque_mil;
  if (diferenca === 0) return null;
  return movimentar(db, {
    produto_id,
    tipo: diferenca > 0 ? 'entrada' : tipo,
    qtd_mil: Math.abs(diferenca),
    observacao: observacao ?? (diferenca > 0 ? 'Acerto de estoque (sobra)' : 'Acerto de estoque (falta)'),
    documento,
    usuario_id,
    permitirNegativo: true,
  });
}

/** Movimentos com filtros simples (produto, tipo e período). */
function movimentos(db, { produto_id = null, tipo = null, de = null, ate = null, limite = 200 } = {}) {
  const where = ['1 = 1'];
  const p = [];
  if (produto_id) { where.push('m.produto_id = ?'); p.push(produto_id); }
  if (tipo) { where.push('m.tipo = ?'); p.push(tipo); }
  if (de) { where.push('m.criado_em >= ?'); p.push(de); }
  if (ate) { where.push('m.criado_em < ?'); p.push(ate); }
  return db.prepare(`SELECT m.*, p.nome AS produto, p.unidade, u.nome AS usuario
    FROM estoque_mov m JOIN produtos p ON p.id = m.produto_id LEFT JOIN usuarios u ON u.id = m.usuario_id
    WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`).all(...p, limite);
}

/** O que precisa de atenção: produtos no mínimo, sem saldo e lotes vencidos ou vencendo. */
function alertas(db) {
  const cfg = lerConfig(db);
  const limite = somarDias(hoje(), cfg.alerta_validade_dias);
  const baixo = db.prepare(`SELECT id, nome, unidade, estoque_mil, estoque_minimo_mil, preco_centavos
    FROM produtos WHERE ativo = 1 AND estoque_minimo_mil > 0 AND estoque_mil <= estoque_minimo_mil ORDER BY (estoque_mil * 1.0 / estoque_minimo_mil), nome`).all();
  const vencendo = db.prepare(`SELECT l.id, l.validade, l.qtd_mil, p.id AS produto_id, p.nome AS produto, p.unidade
    FROM lotes l JOIN produtos p ON p.id = l.produto_id WHERE l.qtd_mil > 0 AND l.validade <= ? ORDER BY l.validade`).all(limite);
  return {
    estoque_baixo: baixo,
    sem_estoque: baixo.filter((x) => x.estoque_mil <= 0).length,
    vencidos: vencendo.filter((l) => l.validade < hoje()),
    vencendo: vencendo.filter((l) => l.validade >= hoje()),
    alerta_validade_dias: cfg.alerta_validade_dias,
  };
}

/** Valor do estoque a preço de custo e a preço de venda. */
const valorEstoque = (db) => db.prepare(`SELECT COALESCE(SUM(estoque_mil * custo_centavos) / 1000, 0) AS custo_centavos,
  COALESCE(SUM(estoque_mil * preco_centavos) / 1000, 0) AS venda_centavos, COUNT(*) AS produtos
  FROM produtos WHERE ativo = 1 AND estoque_mil > 0`).get();

module.exports = { movimentar, ajustarPara, movimentos, alertas, valorEstoque, baixarLotes, entrarLote, novoCustoMedio, qtdTexto };
