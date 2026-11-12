'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const estoque = require('./estoque');
const { hoje, somarDias } = require('./datas');

const compra = (db, id) => db.prepare(`SELECT c.*, f.nome AS fornecedor, f.prazo_pagamento_dias, u.nome AS criada_por_nome
  FROM compras c JOIN fornecedores f ON f.id = c.fornecedor_id LEFT JOIN usuarios u ON u.id = c.criada_por WHERE c.id = ?`).get(id);

const itens = (db, compra_id) => db.prepare(`SELECT i.*, p.nome AS produto, p.unidade, p.codigo_barras, p.preco_centavos AS preco_atual_centavos,
  p.custo_centavos AS custo_atual_centavos, p.estoque_mil FROM compra_itens i JOIN produtos p ON p.id = i.produto_id
  WHERE i.compra_id = ? ORDER BY i.id`).all(compra_id);

function obter(db, id) {
  const c = compra(db, id);
  if (!c) throw naoEncontrado('Compra');
  return { ...c, itens: itens(db, id) };
}

const listar = (db, { status = null, fornecedor_id = null, limite = 100 } = {}) => db.prepare(`SELECT c.*, f.nome AS fornecedor,
  (SELECT COUNT(*) FROM compra_itens i WHERE i.compra_id = c.id) AS itens
  FROM compras c JOIN fornecedores f ON f.id = c.fornecedor_id
  WHERE (? IS NULL OR c.status = ?) AND (? IS NULL OR c.fornecedor_id = ?) ORDER BY c.id DESC LIMIT ?`)
  .all(status, status, fornecedor_id, fornecedor_id, limite);

/** Soma dos itens mais frete, menos desconto. */
function recalcular(db, compra_id) {
  const c = compra(db, compra_id);
  const soma = db.prepare('SELECT COALESCE(SUM(total_centavos), 0) AS total FROM compra_itens WHERE compra_id = ?').get(compra_id).total;
  db.prepare('UPDATE compras SET total_centavos = ? WHERE id = ?').run(Math.max(0, soma + c.frete_centavos - c.desconto_centavos), compra_id);
  return obter(db, compra_id);
}

function exigirRascunho(db, id) {
  const c = compra(db, id);
  if (!c) throw naoEncontrado('Compra');
  if (!['rascunho', 'enviada'].includes(c.status)) throw new ErroNegocio('Esta compra já foi recebida ou cancelada.', 409);
  return c;
}

function criar(db, { fornecedor_id, previsao = null, parcelas = 1, frete_centavos = 0, desconto_centavos = 0, observacao = null, numero_nota = null, itens: lista = [], usuario_id }) {
  if (!db.prepare('SELECT 1 FROM fornecedores WHERE id = ?').get(fornecedor_id)) throw naoEncontrado('Fornecedor');
  return transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO compras (fornecedor_id, numero_nota, previsao, parcelas, frete_centavos, desconto_centavos, observacao, criada_em, criada_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fornecedor_id, numero_nota, previsao, parcelas, frete_centavos, desconto_centavos, observacao, agora(), usuario_id).lastInsertRowid);
    for (const item of lista) adicionarItem(db, id, item);
    return recalcular(db, id);
  });
}

function adicionarItem(db, compra_id, { produto_id, qtd_mil, custo_centavos, validade = null, preco_sugerido_centavos = null }) {
  exigirRascunho(db, compra_id);
  const p = db.prepare('SELECT id, custo_centavos FROM produtos WHERE id = ?').get(produto_id);
  if (!p) throw naoEncontrado('Produto');
  if (!Number.isInteger(qtd_mil) || qtd_mil <= 0) throw new ErroNegocio('Quantidade inválida.', 422);
  const custo = custo_centavos ?? p.custo_centavos;
  db.prepare(`INSERT INTO compra_itens (compra_id, produto_id, qtd_mil, custo_centavos, total_centavos, validade, preco_sugerido_centavos)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(compra_id, produto_id, qtd_mil, custo, Math.round((qtd_mil * custo) / 1000), validade, preco_sugerido_centavos);
  return recalcular(db, compra_id);
}

function removerItem(db, compra_id, item_id) {
  exigirRascunho(db, compra_id);
  const r = db.prepare('DELETE FROM compra_itens WHERE id = ? AND compra_id = ?').run(item_id, compra_id);
  if (!r.changes) throw naoEncontrado('Item');
  return recalcular(db, compra_id);
}

function atualizar(db, id, campos) {
  exigirRascunho(db, id);
  const colunas = Object.keys(campos);
  if (colunas.length) db.prepare(`UPDATE compras SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((c) => campos[c]), id);
  return recalcular(db, id);
}

/** Marca o pedido como enviado ao fornecedor (só muda a situação; serve para acompanhar o que está a caminho). */
function enviar(db, id) {
  const c = compra(db, id);
  if (!c) throw naoEncontrado('Compra');
  if (c.status !== 'rascunho') throw new ErroNegocio('Só um rascunho pode ser enviado.', 409);
  if (!itens(db, id).length) throw new ErroNegocio('Adicione itens antes de enviar o pedido.', 422);
  db.prepare("UPDATE compras SET status = 'enviada', enviada_em = ? WHERE id = ?").run(agora(), id);
  return obter(db, id);
}

/** Parcelas da compra: a primeira vence no prazo do fornecedor e as demais de 30 em 30 dias. */
function gerarContasAPagar(db, c, usuario_id) {
  const base = hoje();
  const valor = c.total_centavos;
  const parcelas = Math.max(1, c.parcelas);
  const fatia = Math.floor(valor / parcelas);
  const sobra = valor - fatia * parcelas;
  for (let i = 0; i < parcelas; i++) {
    const vencimento = somarDias(base, (c.prazo_pagamento_dias ?? 0) + i * 30);
    const sufixo = parcelas > 1 ? ` (${i + 1}/${parcelas})` : '';
    db.prepare(`INSERT INTO lancamentos (tipo, descricao, categoria, fornecedor_id, compra_id, valor_centavos, vencimento, criado_em, criado_por)
      VALUES ('pagar', ?, 'Mercadorias', ?, ?, ?, ?, ?, ?)`)
      .run(`Compra #${c.id} — ${c.fornecedor}${c.numero_nota ? ` (NF ${c.numero_nota})` : ''}${sufixo}`, c.fornecedor_id, c.id,
        i === 0 ? fatia + sobra : fatia, vencimento, agora(), usuario_id);
  }
}

/**
 * Recebimento da mercadoria: dá entrada no estoque (recalculando o custo médio), atualiza o preço de venda
 * quando um novo for informado, registra a validade dos lotes e abre as contas a pagar da nota.
 */
function receber(db, id, { itens: recebidos = [], numero_nota = null, usuario_id }) {
  return transacao(db, () => {
    const c = compra(db, id);
    if (!c) throw naoEncontrado('Compra');
    if (c.status === 'recebida') throw new ErroNegocio('Esta compra já foi recebida.', 409);
    if (c.status === 'cancelada') throw new ErroNegocio('Esta compra foi cancelada.', 409);
    const lista = itens(db, id);
    if (!lista.length) throw new ErroNegocio('A compra está sem itens.', 422);
    const porItem = new Map(recebidos.map((r) => [Number(r.item_id), r]));

    for (const item of lista) {
      const informado = porItem.get(item.id) ?? {};
      const qtd = informado.recebido_mil ?? item.qtd_mil;
      const custo = informado.custo_centavos ?? item.custo_centavos;
      const validade = informado.validade ?? item.validade;
      const precoNovo = informado.preco_sugerido_centavos ?? item.preco_sugerido_centavos;
      db.prepare('UPDATE compra_itens SET recebido_mil = ?, custo_centavos = ?, total_centavos = ?, validade = ?, preco_sugerido_centavos = ? WHERE id = ?')
        .run(qtd, custo, Math.round((qtd * custo) / 1000), validade, precoNovo, item.id);
      if (qtd > 0) {
        estoque.movimentar(db, {
          produto_id: item.produto_id, tipo: 'entrada', qtd_mil: qtd, custo_centavos: custo, validade,
          compra_id: id, usuario_id, documento: numero_nota ?? c.numero_nota ?? `Compra #${id}`, observacao: `Recebimento de ${c.fornecedor}`,
        });
      }
      if (precoNovo) db.prepare('UPDATE produtos SET preco_centavos = ?, atualizado_em = ? WHERE id = ?').run(precoNovo, agora(), item.produto_id);
      db.prepare('UPDATE produtos SET fornecedor_id = COALESCE(fornecedor_id, ?) WHERE id = ?').run(c.fornecedor_id, item.produto_id);
    }
    db.prepare("UPDATE compras SET status = 'recebida', recebida_em = ?, recebida_por = ?, numero_nota = COALESCE(?, numero_nota) WHERE id = ?")
      .run(agora(), usuario_id, numero_nota, id);
    const atualizada = recalcular(db, id);
    gerarContasAPagar(db, { ...atualizada, prazo_pagamento_dias: c.prazo_pagamento_dias, fornecedor: c.fornecedor }, usuario_id);
    return obter(db, id);
  });
}

function cancelar(db, id, motivo) {
  const c = compra(db, id);
  if (!c) throw naoEncontrado('Compra');
  if (c.status === 'recebida') throw new ErroNegocio('Compra recebida não pode ser cancelada: lance uma perda ou devolução no estoque.', 409);
  db.prepare("UPDATE compras SET status = 'cancelada', cancelada_em = ?, observacao = COALESCE(?, observacao) WHERE id = ?").run(agora(), motivo, id);
  return obter(db, id);
}

/**
 * Sugestão de pedido: produtos no mínimo, agrupados pelo fornecedor de costume.
 * A quantidade sugerida repõe o dobro do estoque mínimo (uma semana de folga na prática).
 */
function sugestao(db) {
  const linhas = db.prepare(`SELECT p.id, p.nome, p.unidade, p.estoque_mil, p.estoque_minimo_mil, p.custo_centavos,
      p.fornecedor_id, COALESCE(f.nome, 'Sem fornecedor') AS fornecedor
    FROM produtos p LEFT JOIN fornecedores f ON f.id = p.fornecedor_id
    WHERE p.ativo = 1 AND p.estoque_minimo_mil > 0 AND p.estoque_mil <= p.estoque_minimo_mil
    ORDER BY fornecedor, p.nome`).all();
  const grupos = new Map();
  for (const l of linhas) {
    const chave = l.fornecedor_id ?? 0;
    if (!grupos.has(chave)) grupos.set(chave, { fornecedor_id: l.fornecedor_id, fornecedor: l.fornecedor, itens: [], total_centavos: 0 });
    const sugerido = Math.max(l.estoque_minimo_mil * 2 - l.estoque_mil, l.estoque_minimo_mil);
    const g = grupos.get(chave);
    g.itens.push({ ...l, sugerido_mil: sugerido, total_centavos: Math.round((sugerido * l.custo_centavos) / 1000) });
    g.total_centavos += Math.round((sugerido * l.custo_centavos) / 1000);
  }
  return [...grupos.values()];
}

module.exports = { listar, obter, criar, atualizar, adicionarItem, removerItem, enviar, receber, cancelar, sugestao, itens };
