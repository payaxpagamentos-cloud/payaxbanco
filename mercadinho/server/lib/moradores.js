'use strict';

const { agora, lerConfig, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje, competencia: competenciaDe, somarMeses, diasDaCompetencia, deslocamentoSql } = require('./datas');

/** Saldo da conta: positivo o morador deve, negativo tem crédito. */
const saldo = (db, morador_id) => db.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS saldo FROM conta_morador WHERE morador_id = ?').get(morador_id).saldo;

const limiteDe = (db, morador) => (morador.limite_centavos ?? lerConfig(db).limite_fiado_padrao_centavos);

function obter(db, id) {
  const m = db.prepare('SELECT * FROM moradores WHERE id = ?').get(id);
  if (!m) return null;
  const s = saldo(db, id);
  const limite = limiteDe(db, m);
  return { ...m, saldo_centavos: s, limite_centavos: limite, limite_proprio: m.limite_centavos !== null, disponivel_centavos: Math.max(0, limite - s) };
}

function listar(db, { busca = '', situacao = 'ativos', devedores = false } = {}) {
  const where = [];
  const p = [];
  if (situacao === 'ativos') where.push('m.ativo = 1');
  if (situacao === 'inativos') where.push('m.ativo = 0');
  const t = String(busca ?? '').trim();
  if (t) { where.push('(m.nome LIKE ? OR m.unidade LIKE ? OR m.bloco LIKE ?)'); p.push(`%${t}%`, `%${t}%`, `%${t}%`); }
  const padrao = lerConfig(db).limite_fiado_padrao_centavos;
  const linhas = db.prepare(`SELECT m.*, COALESCE((SELECT SUM(valor_centavos) FROM conta_morador cm WHERE cm.morador_id = m.id), 0) AS saldo_centavos
    FROM moradores m ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.bloco, m.unidade, m.nome`).all(...p);
  const comLimite = linhas.map((m) => {
    const limite = m.limite_centavos ?? padrao;
    return { ...m, limite_centavos: limite, limite_proprio: m.limite_centavos !== null, disponivel_centavos: Math.max(0, limite - m.saldo_centavos) };
  });
  return devedores ? comLimite.filter((m) => m.saldo_centavos > 0) : comLimite;
}

function criar(db, d) {
  const r = db.prepare(`INSERT INTO moradores (nome, bloco, unidade, telefone, email, documento, limite_centavos, fiado_liberado, observacao, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.nome, d.bloco, d.unidade, d.telefone, d.email, d.documento, d.limite_centavos, d.fiado_liberado ? 1 : 0, d.observacao, agora());
  return obter(db, Number(r.lastInsertRowid));
}

function atualizar(db, id, campos) {
  if (!db.prepare('SELECT 1 FROM moradores WHERE id = ?').get(id)) throw naoEncontrado('Morador');
  const colunas = Object.keys(campos);
  if (colunas.length) db.prepare(`UPDATE moradores SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((c) => campos[c]), id);
  return obter(db, id);
}

/** Lança na conta do morador. Compras entram positivas (dívida); pagamentos e estornos, negativos. */
function lancar(db, { morador_id, tipo, descricao, valor_centavos, venda_id = null, fatura_id = null, usuario_id = null }) {
  const r = db.prepare(`INSERT INTO conta_morador (morador_id, tipo, descricao, valor_centavos, venda_id, fatura_id, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(morador_id, tipo, descricao, valor_centavos, venda_id, fatura_id, usuario_id, agora());
  return Number(r.lastInsertRowid);
}

/** Confere se o morador pode levar fiado o valor pedido. */
function conferirLimite(db, morador_id, valor_centavos) {
  const m = obter(db, morador_id);
  if (!m) throw naoEncontrado('Morador');
  if (!m.ativo) throw new ErroNegocio('Morador inativo: não é possível lançar na conta.', 409);
  if (!m.fiado_liberado) throw new ErroNegocio(`${m.nome} está sem permissão para comprar na conta.`, 409);
  const novo = m.saldo_centavos + valor_centavos;
  if (novo > m.limite_centavos) {
    const falta = ((novo - m.limite_centavos) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    throw new ErroNegocio(`Limite da conta de ${m.nome} estourado em ${falta}. Receba parte do saldo ou aumente o limite.`, 409);
  }
  return m;
}

const extrato = (db, morador_id, { limite = 200 } = {}) => db.prepare(`SELECT c.*, u.nome AS usuario FROM conta_morador c
  LEFT JOIN usuarios u ON u.id = c.usuario_id WHERE c.morador_id = ? ORDER BY c.id DESC LIMIT ?`).all(morador_id, limite);

const faturas = (db, { morador_id = null, status = null, competencia = null } = {}) => db.prepare(`SELECT f.*, m.nome AS morador, m.bloco, m.unidade
  FROM faturas f JOIN moradores m ON m.id = f.morador_id
  WHERE (? IS NULL OR f.morador_id = ?) AND (? IS NULL OR f.status = ?) AND (? IS NULL OR f.competencia = ?)
  ORDER BY f.competencia DESC, m.bloco, m.unidade`).all(morador_id, morador_id, status, status, competencia, competencia);

/**
 * Fecha o mês: para cada morador com compras na competência, gera a fatura e a conta a receber.
 * Rodar de novo na mesma competência só cria o que faltava (a fatura é única por morador e mês).
 */
function fecharCompetencia(db, competencia, usuario_id) {
  const cfg = lerConfig(db);
  const [inicio, fim] = diasDaCompetencia(competencia);
  const vencimento = `${somarMeses(competencia, 1)}-${String(cfg.vencimento_fatura_dia).padStart(2, '0')}`;
  return transacao(db, () => {
    const fuso = deslocamentoSql();
    const linhas = db.prepare(`SELECT morador_id, COUNT(*) AS compras, SUM(valor_centavos) AS total FROM conta_morador
      WHERE tipo IN ('compra','estorno') AND fatura_id IS NULL AND date(criado_em, ?) BETWEEN ? AND ? AND morador_id IS NOT NULL
      GROUP BY morador_id HAVING total > 0`).all(fuso, inicio, fim);
    const criadas = [];
    for (const l of linhas) {
      if (db.prepare('SELECT 1 FROM faturas WHERE morador_id = ? AND competencia = ?').get(l.morador_id, competencia)) continue;
      const id = Number(db.prepare(`INSERT INTO faturas (morador_id, competencia, compras, valor_centavos, vencimento, criada_em, criada_por)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(l.morador_id, competencia, l.compras, l.total, vencimento, agora(), usuario_id).lastInsertRowid);
      db.prepare(`UPDATE conta_morador SET fatura_id = ? WHERE morador_id = ? AND fatura_id IS NULL AND tipo IN ('compra','estorno')
        AND date(criado_em, ?) BETWEEN ? AND ?`).run(id, l.morador_id, fuso, inicio, fim);
      const m = db.prepare('SELECT nome, bloco, unidade FROM moradores WHERE id = ?').get(l.morador_id);
      db.prepare(`INSERT INTO lancamentos (tipo, descricao, categoria, morador_id, fatura_id, valor_centavos, vencimento, criado_em, criado_por)
        VALUES ('receber', ?, 'Conta de morador', ?, ?, ?, ?, ?, ?)`)
        .run(`Fatura ${competencia} — ${m.nome} (${m.bloco}/${m.unidade})`, l.morador_id, id, l.total, vencimento, agora(), usuario_id);
      criadas.push(id);
    }
    return { competencia, vencimento, faturas: criadas.length, valor_centavos: linhas.reduce((s, l) => s + l.total, 0) };
  });
}

/** Recebe dinheiro do morador: abate o saldo e quita as faturas abertas, das mais antigas para as mais novas. */
function receber(db, morador_id, { valor_centavos, forma = 'dinheiro', observacao = null, usuario_id = null }) {
  const m = obter(db, morador_id);
  if (!m) throw naoEncontrado('Morador');
  if (!Number.isInteger(valor_centavos) || valor_centavos <= 0) throw new ErroNegocio('Valor inválido.', 422);
  return transacao(db, () => {
    lancar(db, { morador_id, tipo: 'pagamento', descricao: observacao ?? `Pagamento em ${forma}`, valor_centavos: -valor_centavos, usuario_id });
    let restante = valor_centavos;
    for (const f of db.prepare("SELECT * FROM faturas WHERE morador_id = ? AND status = 'aberta' ORDER BY competencia").all(morador_id)) {
      if (restante < f.valor_centavos) break;
      restante -= f.valor_centavos;
      db.prepare("UPDATE faturas SET status = 'paga', paga_em = ? WHERE id = ?").run(agora(), f.id);
      db.prepare("UPDATE lancamentos SET status = 'pago', pago_em = ?, pago_centavos = valor_centavos, forma = ? WHERE fatura_id = ? AND status = 'aberto'")
        .run(hoje(), forma, f.id);
    }
    return obter(db, morador_id);
  });
}

/** Consumo do morador no mês, para o extrato e para o portal dele. */
const consumoDoMes = (db, morador_id, competencia = competenciaDe()) => {
  const [inicio, fim] = diasDaCompetencia(competencia);
  return db.prepare(`SELECT COUNT(*) AS compras, COALESCE(SUM(valor_centavos), 0) AS total_centavos FROM conta_morador
    WHERE morador_id = ? AND tipo = 'compra' AND date(criado_em, ?) BETWEEN ? AND ?`).get(morador_id, deslocamentoSql(), inicio, fim);
};

module.exports = { listar, obter, criar, atualizar, saldo, limiteDe, lancar, conferirLimite, extrato, faturas, fecharCompetencia, receber, consumoDoMes };
