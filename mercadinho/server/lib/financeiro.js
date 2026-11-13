'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje, somarDias, diasDaCompetencia, intervalo, deslocamentoSql, competencia: competenciaDe } = require('./datas');

const CATEGORIAS = ['Mercadorias', 'Conta de morador', 'Cartão', 'Energia', 'Água', 'Internet e telefone', 'Rateio do condomínio',
  'Manutenção', 'Pessoal', 'Impostos e taxas', 'Embalagens', 'Outros'];

const lancamento = (db, id) => db.prepare(`SELECT l.*, f.nome AS fornecedor, m.nome AS morador FROM lancamentos l
  LEFT JOIN fornecedores f ON f.id = l.fornecedor_id LEFT JOIN moradores m ON m.id = l.morador_id WHERE l.id = ?`).get(id);

function listar(db, { tipo = null, status = null, categoria = null, fornecedor_id = null, morador_id = null, de = null, ate = null, vencidos = false, limite = 300 } = {}) {
  const where = [];
  const p = [];
  if (tipo) { where.push('l.tipo = ?'); p.push(tipo); }
  if (status) { where.push('l.status = ?'); p.push(status); }
  if (categoria) { where.push('l.categoria = ?'); p.push(categoria); }
  if (fornecedor_id) { where.push('l.fornecedor_id = ?'); p.push(fornecedor_id); }
  if (morador_id) { where.push('l.morador_id = ?'); p.push(morador_id); }
  if (de) { where.push('l.vencimento >= ?'); p.push(de); }
  if (ate) { where.push('l.vencimento <= ?'); p.push(ate); }
  if (vencidos) { where.push("l.status = 'aberto' AND l.vencimento < ?"); p.push(hoje()); }
  return db.prepare(`SELECT l.*, f.nome AS fornecedor, m.nome AS morador FROM lancamentos l
    LEFT JOIN fornecedores f ON f.id = l.fornecedor_id LEFT JOIN moradores m ON m.id = l.morador_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.vencimento, l.id LIMIT ?`).all(...p, limite);
}

function criar(db, d, usuario_id) {
  const r = db.prepare(`INSERT INTO lancamentos (tipo, descricao, categoria, fornecedor_id, morador_id, valor_centavos, vencimento, observacao, criado_em, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.tipo, d.descricao, d.categoria ?? 'Outros', d.fornecedor_id ?? null, d.morador_id ?? null, d.valor_centavos, d.vencimento, d.observacao ?? null, agora(), usuario_id);
  return lancamento(db, Number(r.lastInsertRowid));
}

function atualizar(db, id, campos) {
  const l = lancamento(db, id);
  if (!l) throw naoEncontrado('Lançamento');
  if (l.status === 'pago') throw new ErroNegocio('Lançamento já baixado: estorne a baixa antes de alterar.', 409);
  const colunas = Object.keys(campos);
  if (colunas.length) db.prepare(`UPDATE lancamentos SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((c) => campos[c]), id);
  return lancamento(db, id);
}

/** Baixa do lançamento (pagamento ou recebimento). Quando é a fatura de um morador, a conta dele também é quitada. */
function baixar(db, id, { pago_em = hoje(), pago_centavos = null, forma = 'dinheiro', usuario_id = null }) {
  return transacao(db, () => {
    const l = lancamento(db, id);
    if (!l) throw naoEncontrado('Lançamento');
    if (l.status !== 'aberto') throw new ErroNegocio('Este lançamento não está em aberto.', 409);
    const valor = pago_centavos ?? l.valor_centavos;
    db.prepare("UPDATE lancamentos SET status = 'pago', pago_em = ?, pago_centavos = ?, forma = ? WHERE id = ?").run(pago_em, valor, forma, id);
    if (l.fatura_id) {
      db.prepare("UPDATE faturas SET status = 'paga', paga_em = ? WHERE id = ? AND status = 'aberta'").run(agora(), l.fatura_id);
      const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(l.fatura_id);
      if (f) {
        require('./moradores').lancar(db, {
          morador_id: f.morador_id, tipo: 'pagamento', descricao: `Pagamento da fatura ${f.competencia}`, valor_centavos: -valor, fatura_id: f.id, usuario_id,
        });
      }
    }
    return lancamento(db, id);
  });
}

function estornar(db, id) {
  const l = lancamento(db, id);
  if (!l) throw naoEncontrado('Lançamento');
  if (l.status !== 'pago') throw new ErroNegocio('Só é possível estornar um lançamento baixado.', 409);
  if (l.fatura_id) throw new ErroNegocio('Estorne pela conta do morador: esta baixa quitou uma fatura.', 409);
  db.prepare("UPDATE lancamentos SET status = 'aberto', pago_em = NULL, pago_centavos = NULL, forma = NULL WHERE id = ?").run(id);
  return lancamento(db, id);
}

function cancelar(db, id, motivo) {
  const l = lancamento(db, id);
  if (!l) throw naoEncontrado('Lançamento');
  if (l.status === 'pago') throw new ErroNegocio('Lançamento já baixado: estorne antes de cancelar.', 409);
  db.prepare("UPDATE lancamentos SET status = 'cancelado', observacao = COALESCE(?, observacao) WHERE id = ?").run(motivo, id);
  return lancamento(db, id);
}

/** Visão rápida do financeiro: vencidos, do dia, da semana e o total em aberto dos dois lados. */
function resumo(db) {
  const d = hoje();
  const semana = somarDias(d, 7);
  const bloco = (tipo) => ({
    vencido_centavos: db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS v FROM lancamentos WHERE tipo = ? AND status = 'aberto' AND vencimento < ?").get(tipo, d).v,
    hoje_centavos: db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS v FROM lancamentos WHERE tipo = ? AND status = 'aberto' AND vencimento = ?").get(tipo, d).v,
    semana_centavos: db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS v FROM lancamentos WHERE tipo = ? AND status = 'aberto' AND vencimento > ? AND vencimento <= ?").get(tipo, d, semana).v,
    aberto_centavos: db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS v FROM lancamentos WHERE tipo = ? AND status = 'aberto'").get(tipo).v,
  });
  const pagar = bloco('pagar');
  const receber = bloco('receber');
  return { hoje: d, pagar, receber, saldo_previsto_centavos: receber.aberto_centavos - pagar.aberto_centavos };
}

/**
 * Fluxo de caixa diário. Entram as vendas recebidas na hora (dinheiro e PIX) e as contas a receber baixadas;
 * saem as contas a pagar baixadas. O fiado e o cartão entram no dia em que o dinheiro realmente cai.
 */
function fluxo(db, { de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  const vendas = db.prepare(`SELECT date(v.fechada_em, ?) AS dia, COALESCE(SUM(pg.valor_centavos - pg.troco_centavos), 0) AS total
    FROM pagamentos pg JOIN vendas v ON v.id = pg.venda_id
    WHERE v.status = 'paga' AND pg.forma IN ('dinheiro','pix') AND v.fechada_em >= ? AND v.fechada_em < ? GROUP BY dia`).all(deslocamentoSql(), inicio, fim);
  const recebidos = db.prepare(`SELECT pago_em AS dia, COALESCE(SUM(pago_centavos), 0) AS total FROM lancamentos
    WHERE tipo = 'receber' AND status = 'pago' AND pago_em BETWEEN ? AND ? GROUP BY dia`).all(de, ate);
  const pagos = db.prepare(`SELECT pago_em AS dia, COALESCE(SUM(pago_centavos), 0) AS total FROM lancamentos
    WHERE tipo = 'pagar' AND status = 'pago' AND pago_em BETWEEN ? AND ? GROUP BY dia`).all(de, ate);
  const mapa = new Map();
  const por = (linhas, campo) => { for (const l of linhas) mapa.set(l.dia, { ...(mapa.get(l.dia) ?? { dia: l.dia, vendas: 0, recebimentos: 0, pagamentos: 0 }), [campo]: l.total }); };
  por(vendas, 'vendas'); por(recebidos, 'recebimentos'); por(pagos, 'pagamentos');
  let acumulado = 0;
  const dias = [...mapa.values()].sort((a, b) => a.dia.localeCompare(b.dia)).map((d2) => {
    const entradas = d2.vendas + d2.recebimentos;
    acumulado += entradas - d2.pagamentos;
    return { ...d2, entradas_centavos: entradas, saidas_centavos: d2.pagamentos, saldo_centavos: entradas - d2.pagamentos, acumulado_centavos: acumulado };
  });
  return {
    de, ate, dias,
    entradas_centavos: dias.reduce((s, x) => s + x.entradas_centavos, 0),
    saidas_centavos: dias.reduce((s, x) => s + x.saidas_centavos, 0),
    saldo_centavos: acumulado,
  };
}

/**
 * DRE do mês: receita das vendas, custo da mercadoria vendida, taxas da maquininha e despesas pagas.
 * As compras não entram como despesa (viram estoque): o que pesa no resultado é o custo do que foi vendido.
 */
function dre(db, competencia = competenciaDe()) {
  const [de, ate] = diasDaCompetencia(competencia);
  const [inicio, fim] = intervalo(de, ate);
  const vendas = db.prepare(`SELECT COUNT(*) AS quantidade, COALESCE(SUM(subtotal_centavos), 0) AS bruto, COALESCE(SUM(desconto_centavos), 0) AS descontos,
    COALESCE(SUM(total_centavos), 0) AS liquido, COALESCE(SUM(custo_centavos), 0) AS custo
    FROM vendas WHERE status = 'paga' AND fechada_em >= ? AND fechada_em < ?`).get(inicio, fim);
  const taxas = db.prepare(`SELECT COALESCE(SUM(taxa_centavos), 0) AS total FROM transacoes_cartao
    WHERE status = 'aprovada' AND criada_em >= ? AND criada_em < ?`).get(inicio, fim).total;
  const despesas = db.prepare(`SELECT categoria, COALESCE(SUM(pago_centavos), 0) AS total FROM lancamentos
    WHERE tipo = 'pagar' AND status = 'pago' AND pago_em BETWEEN ? AND ? AND categoria <> 'Mercadorias' GROUP BY categoria ORDER BY total DESC`).all(de, ate);
  const perdas = db.prepare(`SELECT COALESCE(SUM(ABS(m.qtd_mil) * m.custo_centavos / 1000), 0) AS total FROM estoque_mov m
    WHERE m.tipo IN ('perda','inventario') AND m.qtd_mil < 0 AND m.criado_em >= ? AND m.criado_em < ?`).get(inicio, fim).total;
  const lucroBruto = vendas.liquido - vendas.custo;
  const totalDespesas = despesas.reduce((s, d) => s + d.total, 0);
  return {
    competencia,
    vendas: vendas.quantidade,
    receita_bruta_centavos: vendas.bruto,
    descontos_centavos: vendas.descontos,
    receita_liquida_centavos: vendas.liquido,
    cmv_centavos: vendas.custo,
    lucro_bruto_centavos: lucroBruto,
    margem_bruta_bp: vendas.liquido ? Math.round((lucroBruto / vendas.liquido) * 10_000) : 0,
    taxas_cartao_centavos: taxas,
    perdas_centavos: Math.round(perdas),
    despesas,
    despesas_centavos: totalDespesas,
    resultado_centavos: lucroBruto - taxas - totalDespesas - Math.round(perdas),
  };
}

module.exports = { listar, criar, atualizar, baixar, estornar, cancelar, resumo, fluxo, dre, lancamento, CATEGORIAS };
