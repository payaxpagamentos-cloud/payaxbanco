'use strict';

/*
 * Limite diário do Internet Banking (PIX, transferências e pagamentos).
 * O cliente pode alterar o próprio limite: reduções valem na hora; aumentos entram em vigor 24 horas depois
 * do pedido (prazo de segurança contra golpes, como pede o Banco Central para limites de PIX). Durante o prazo
 * o cliente pode cancelar e a equipe pode recusar. Pedidos vencidos são efetivados na próxima leitura do limite.
 */

const config = require('../config');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { registrar } = require('./auditoria');
const v = require('./validacao');

const PRAZO_HORAS = 24;
const SAIDAS = "('pix_enviado','transferencia_enviada','pagamento')";

/** Efetiva os aumentos cujo prazo terminou (chamado antes de qualquer leitura ou uso do limite). */
function efetivarVencidos(db) {
  const vencidos = db.prepare("SELECT * FROM pedidos_limite WHERE status = 'agendado' AND efetiva_em <= datetime('now')").all();
  for (const p of vencidos) {
    db.prepare('UPDATE acessos_cliente SET limite_diario_centavos = ? WHERE cliente_id = ?').run(p.valor_novo_centavos, p.cliente_id);
    db.prepare("UPDATE pedidos_limite SET status = 'efetivado', concluido_em = datetime('now') WHERE id = ?").run(p.id);
    registrar(db, {}, 'limite_diario_efetivado', 'cliente', p.cliente_id, { pedido: p.id, de: p.valor_atual_centavos, para: p.valor_novo_centavos });
  }
}

/** Limite, uso de hoje e pedido em andamento do cliente. */
function situacao(db, clienteId) {
  efetivarVencidos(db);
  const a = db.prepare('SELECT limite_diario_centavos FROM acessos_cliente WHERE cliente_id = ?').get(clienteId);
  if (!a) return null;
  const { usado } = db.prepare(`SELECT COALESCE(-SUM(t.valor_centavos), 0) AS usado FROM transacoes t JOIN contas c ON c.id = t.conta_id
    WHERE c.cliente_id = ? AND t.canal = 'internet_banking' AND t.tipo IN ${SAIDAS} AND t.estornada_em IS NULL
      AND date(t.criado_em, ?) = date('now', ?)`).get(clienteId, config.fusoSqlite, config.fusoSqlite);
  const limite = a.limite_diario_centavos;
  return {
    limite_centavos: limite,
    usado_centavos: usado,
    disponivel_centavos: Math.max(0, limite - usado),
    maximo_centavos: config.limiteDiarioMaximoCentavos,
    prazo_horas: PRAZO_HORAS,
    pedido: pendente(db, clienteId),
  };
}

const pendente = (db, clienteId) => db.prepare(`SELECT id, valor_atual_centavos, valor_novo_centavos, efetiva_em, criado_em,
    CAST(ROUND((julianday(efetiva_em) - julianday('now')) * 86400) AS INTEGER) AS segundos_restantes
  FROM pedidos_limite WHERE cliente_id = ? AND status = 'agendado' ORDER BY id DESC LIMIT 1`).get(clienteId) ?? null;

const listar = (db, clienteId) => {
  efetivarVencidos(db);
  return db.prepare(`SELECT p.id, p.valor_atual_centavos, p.valor_novo_centavos, p.status, p.efetiva_em, p.criado_em, p.concluido_em, p.motivo,
      u.nome AS decidido_por_nome FROM pedidos_limite p LEFT JOIN usuarios u ON u.id = p.decidido_por WHERE p.cliente_id = ? ORDER BY p.id DESC LIMIT 50`).all(clienteId);
};

/** Pedido do cliente: redução imediata; aumento agendado para daqui a 24 horas. */
function pedir(db, req, clienteId, valorNovo) {
  efetivarVencidos(db);
  const novo = Number(valorNovo);
  v.exigir(Number.isInteger(novo) && novo >= 0, 'Informe o novo limite.');
  const atual = db.prepare('SELECT limite_diario_centavos FROM acessos_cliente WHERE cliente_id = ?').get(clienteId);
  if (!atual) throw naoEncontrado('Acesso ao Internet Banking');
  if (novo === atual.limite_diario_centavos) throw new ErroNegocio('O novo limite é igual ao atual.', 422);
  const max = config.limiteDiarioMaximoCentavos;
  if (novo > max) {
    throw new ErroNegocio(`Pelo Internet Banking o limite diário vai até ${(max / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Para mais, fale com seu gerente.`, 422);
  }
  if (pendente(db, clienteId)) throw new ErroNegocio('Você já tem um aumento de limite agendado. Cancele-o para fazer outro pedido.', 409);
  if (novo < atual.limite_diario_centavos) {
    db.prepare('UPDATE acessos_cliente SET limite_diario_centavos = ? WHERE cliente_id = ?').run(novo, clienteId);
    const r = db.prepare(`INSERT INTO pedidos_limite (cliente_id, valor_atual_centavos, valor_novo_centavos, status, efetiva_em, concluido_em)
      VALUES (?, ?, ?, 'efetivado', datetime('now'), datetime('now'))`).run(clienteId, atual.limite_diario_centavos, novo);
    registrar(db, req, 'limite_diario_reduzido', 'cliente', clienteId, { pedido: Number(r.lastInsertRowid), de: atual.limite_diario_centavos, para: novo });
    return { imediato: true, ...situacao(db, clienteId) };
  }
  const r = db.prepare(`INSERT INTO pedidos_limite (cliente_id, valor_atual_centavos, valor_novo_centavos, status, efetiva_em)
    VALUES (?, ?, ?, 'agendado', datetime('now', '+${PRAZO_HORAS} hours'))`).run(clienteId, atual.limite_diario_centavos, novo);
  registrar(db, req, 'limite_diario_aumento_pedido', 'cliente', clienteId, { pedido: Number(r.lastInsertRowid), de: atual.limite_diario_centavos, para: novo });
  return { imediato: false, ...situacao(db, clienteId) };
}

function buscarPendente(db, id, clienteId) {
  const p = db.prepare("SELECT * FROM pedidos_limite WHERE id = ? AND status = 'agendado'").get(id);
  if (!p || (clienteId && p.cliente_id !== clienteId)) throw naoEncontrado('Pedido de aumento em andamento');
  return p;
}

function cancelar(db, req, clienteId, id) {
  efetivarVencidos(db);
  const p = buscarPendente(db, id, clienteId);
  db.prepare("UPDATE pedidos_limite SET status = 'cancelado', concluido_em = datetime('now') WHERE id = ?").run(p.id);
  registrar(db, req, 'limite_diario_aumento_cancelado', 'cliente', p.cliente_id, { pedido: p.id });
}

/** A equipe (alçada de gerenciar o Internet Banking) recusa o aumento durante o prazo. */
function recusar(db, req, id, motivo) {
  efetivarVencidos(db);
  const p = buscarPendente(db, id);
  const texto = v.texto(motivo, 500);
  v.exigir(texto && texto.length >= 5, 'Informe o motivo da recusa.');
  db.prepare("UPDATE pedidos_limite SET status = 'recusado', motivo = ?, decidido_por = ?, concluido_em = datetime('now') WHERE id = ?").run(texto, req.usuario.id, p.id);
  registrar(db, req, 'limite_diario_aumento_recusado', 'cliente', p.cliente_id, { pedido: p.id, motivo: texto });
  return p.cliente_id;
}

module.exports = { PRAZO_HORAS, efetivarVencidos, situacao, listar, pedir, cancelar, recusar };
