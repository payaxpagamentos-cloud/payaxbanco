'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');

const FORMAS = ['dinheiro', 'pix', 'debito', 'credito', 'fiado'];

const obter = (db, id) => db.prepare(`SELECT c.*, u.nome AS operador, f.nome AS fechado_por_nome
  FROM caixas c LEFT JOIN usuarios u ON u.id = c.usuario_id LEFT JOIN usuarios f ON f.id = c.fechado_por WHERE c.id = ?`).get(id);

/** Caixa aberto do operador (cada um opera o seu). */
const abertoDo = (db, usuario_id) => db.prepare("SELECT * FROM caixas WHERE usuario_id = ? AND status = 'aberto' ORDER BY id DESC").get(usuario_id);
const abertos = (db) => db.prepare(`SELECT c.*, u.nome AS operador FROM caixas c LEFT JOIN usuarios u ON u.id = c.usuario_id WHERE c.status = 'aberto' ORDER BY c.id`).all();

function abrirCaixa(db, { usuario_id, abertura_centavos = 0, observacao = null }) {
  if (abertoDo(db, usuario_id)) throw new ErroNegocio('Você já tem um caixa aberto. Feche-o antes de abrir outro.', 409);
  const r = db.prepare('INSERT INTO caixas (usuario_id, abertura_centavos, aberto_em, observacao) VALUES (?, ?, ?, ?)')
    .run(usuario_id, abertura_centavos, agora(), observacao);
  return obter(db, Number(r.lastInsertRowid));
}

function exigirAberto(db, caixa_id) {
  const caixa = db.prepare('SELECT * FROM caixas WHERE id = ?').get(caixa_id);
  if (!caixa) throw naoEncontrado('Caixa');
  if (caixa.status !== 'aberto') throw new ErroNegocio('Este caixa já foi fechado.', 409);
  return caixa;
}

/** Suprimento (entra dinheiro para troco) e sangria (retirada do caixa para o cofre). */
function movimentar(db, caixa_id, { tipo, valor_centavos, motivo, usuario_id }) {
  exigirAberto(db, caixa_id);
  if (!['suprimento', 'sangria'].includes(tipo)) throw new ErroNegocio('Movimento de caixa inválido.', 422);
  if (!Number.isInteger(valor_centavos) || valor_centavos <= 0) throw new ErroNegocio('Valor inválido.', 422);
  if (tipo === 'sangria') {
    const { dinheiro_esperado_centavos } = resumo(db, caixa_id);
    if (valor_centavos > dinheiro_esperado_centavos) throw new ErroNegocio('A sangria é maior do que o dinheiro em caixa.', 409);
  }
  const r = db.prepare('INSERT INTO caixa_mov (caixa_id, tipo, valor_centavos, motivo, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(caixa_id, tipo, valor_centavos, motivo, usuario_id, agora());
  return db.prepare('SELECT * FROM caixa_mov WHERE id = ?').get(Number(r.lastInsertRowid));
}

/** Como está o caixa agora: vendas por forma de pagamento, suprimentos, sangrias e o dinheiro que deve estar na gaveta. */
function resumo(db, caixa_id) {
  const caixa = obter(db, caixa_id);
  if (!caixa) throw naoEncontrado('Caixa');
  const porForma = Object.fromEntries(FORMAS.map((f) => [f, 0]));
  for (const linha of db.prepare(`SELECT pg.forma, SUM(pg.valor_centavos) AS total FROM pagamentos pg
    JOIN vendas v ON v.id = pg.venda_id WHERE v.caixa_id = ? AND v.status = 'paga' GROUP BY pg.forma`).all(caixa_id)) {
    porForma[linha.forma] = linha.total;
  }
  const vendas = db.prepare("SELECT COUNT(*) AS quantidade, COALESCE(SUM(total_centavos), 0) AS total, COALESCE(SUM(custo_centavos), 0) AS custo FROM vendas WHERE caixa_id = ? AND status = 'paga'").get(caixa_id);
  const canceladas = db.prepare("SELECT COUNT(*) AS quantidade FROM vendas WHERE caixa_id = ? AND status = 'cancelada'").get(caixa_id).quantidade;
  const mov = db.prepare('SELECT tipo, COALESCE(SUM(valor_centavos), 0) AS total FROM caixa_mov WHERE caixa_id = ? GROUP BY tipo').all(caixa_id);
  const suprimentos = mov.find((m) => m.tipo === 'suprimento')?.total ?? 0;
  const sangrias = mov.find((m) => m.tipo === 'sangria')?.total ?? 0;
  const trocos = db.prepare(`SELECT COALESCE(SUM(pg.troco_centavos), 0) AS total FROM pagamentos pg JOIN vendas v ON v.id = pg.venda_id
    WHERE v.caixa_id = ? AND v.status = 'paga'`).get(caixa_id).total;
  return {
    caixa,
    vendas: vendas.quantidade,
    canceladas,
    total_centavos: vendas.total,
    custo_centavos: vendas.custo,
    lucro_centavos: vendas.total - vendas.custo,
    ticket_medio_centavos: vendas.quantidade ? Math.round(vendas.total / vendas.quantidade) : 0,
    por_forma: porForma,
    suprimentos_centavos: suprimentos,
    sangrias_centavos: sangrias,
    trocos_centavos: trocos,
    dinheiro_esperado_centavos: caixa.abertura_centavos + porForma.dinheiro + suprimentos - sangrias,
    movimentos: db.prepare('SELECT * FROM caixa_mov WHERE caixa_id = ? ORDER BY id DESC').all(caixa_id),
  };
}

/** Fecha o caixa com a conferência do dinheiro contado; a diferença fica registrada (sobra ou falta). */
function fechar(db, caixa_id, { informado_centavos, observacao = null, usuario_id }) {
  return transacao(db, () => {
    exigirAberto(db, caixa_id);
    const abertas = db.prepare("SELECT COUNT(*) AS n FROM vendas WHERE caixa_id = ? AND status = 'aberta'").get(caixa_id).n;
    if (abertas) throw new ErroNegocio(`Há ${abertas} venda(s) em aberto neste caixa. Finalize ou cancele antes de fechar.`, 409);
    const r = resumo(db, caixa_id);
    const esperado = r.dinheiro_esperado_centavos;
    db.prepare(`UPDATE caixas SET status = 'fechado', fechado_em = ?, fechado_por = ?, esperado_centavos = ?, informado_centavos = ?,
      diferenca_centavos = ?, observacao = COALESCE(?, observacao) WHERE id = ?`)
      .run(agora(), usuario_id, esperado, informado_centavos, informado_centavos - esperado, observacao, caixa_id);
    return resumo(db, caixa_id);
  });
}

const historico = (db, { de = null, ate = null, limite = 60 } = {}) => db.prepare(`SELECT c.*, u.nome AS operador,
  (SELECT COUNT(*) FROM vendas v WHERE v.caixa_id = c.id AND v.status = 'paga') AS vendas,
  (SELECT COALESCE(SUM(v.total_centavos), 0) FROM vendas v WHERE v.caixa_id = c.id AND v.status = 'paga') AS total_centavos
  FROM caixas c LEFT JOIN usuarios u ON u.id = c.usuario_id
  WHERE (? IS NULL OR c.aberto_em >= ?) AND (? IS NULL OR c.aberto_em < ?) ORDER BY c.id DESC LIMIT ?`).all(de, de, ate, ate, limite);

module.exports = { abrirCaixa, abertoDo, abertos, obter, exigirAberto, movimentar, resumo, fechar, historico, FORMAS };
