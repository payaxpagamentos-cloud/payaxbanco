'use strict';

const { intervalo, deslocamentoSql } = require('./datas');

/** Vendas do período: totais, ticket médio e a série por dia. */
function vendas(db, { de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  const total = db.prepare(`SELECT COUNT(*) AS vendas, COALESCE(SUM(total_centavos), 0) AS total, COALESCE(SUM(custo_centavos), 0) AS custo,
    COALESCE(SUM(desconto_centavos), 0) AS descontos FROM vendas WHERE status = 'paga' AND fechada_em >= ? AND fechada_em < ?`).get(inicio, fim);
  const fuso = deslocamentoSql();
  const porDia = db.prepare(`SELECT date(fechada_em, ?) AS dia, COUNT(*) AS vendas, COALESCE(SUM(total_centavos), 0) AS total,
    COALESCE(SUM(custo_centavos), 0) AS custo FROM vendas WHERE status = 'paga' AND fechada_em >= ? AND fechada_em < ? GROUP BY dia ORDER BY dia`).all(fuso, inicio, fim);
  const porForma = db.prepare(`SELECT pg.forma, COUNT(*) AS quantidade, COALESCE(SUM(pg.valor_centavos), 0) AS total FROM pagamentos pg
    JOIN vendas v ON v.id = pg.venda_id WHERE v.status = 'paga' AND v.fechada_em >= ? AND v.fechada_em < ? GROUP BY pg.forma ORDER BY total DESC`).all(inicio, fim);
  const porHora = db.prepare(`SELECT CAST(strftime('%H', fechada_em, ?) AS INTEGER) AS hora, COUNT(*) AS vendas,
    COALESCE(SUM(total_centavos), 0) AS total FROM vendas WHERE status = 'paga' AND fechada_em >= ? AND fechada_em < ? GROUP BY hora ORDER BY hora`).all(fuso, inicio, fim);
  return {
    de, ate,
    vendas: total.vendas,
    total_centavos: total.total,
    custo_centavos: total.custo,
    lucro_centavos: total.total - total.custo,
    descontos_centavos: total.descontos,
    ticket_medio_centavos: total.vendas ? Math.round(total.total / total.vendas) : 0,
    margem_bp: total.total ? Math.round(((total.total - total.custo) / total.total) * 10_000) : 0,
    por_dia: porDia,
    por_forma: porForma,
    por_hora: porHora,
  };
}

/** Produtos mais vendidos no período, com lucro e participação. */
function maisVendidos(db, { de, ate, limite = 20 }) {
  const [inicio, fim] = intervalo(de, ate);
  const linhas = db.prepare(`SELECT p.id, p.nome, p.unidade, c.nome AS categoria,
      SUM(i.qtd_mil) AS qtd_mil, SUM(i.total_centavos) AS total_centavos,
      SUM(i.qtd_mil * i.custo_centavos / 1000) AS custo_centavos
    FROM venda_itens i JOIN vendas v ON v.id = i.venda_id JOIN produtos p ON p.id = i.produto_id
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE v.status = 'paga' AND v.fechada_em >= ? AND v.fechada_em < ?
    GROUP BY p.id ORDER BY total_centavos DESC LIMIT ?`).all(inicio, fim, limite);
  const total = linhas.reduce((s, l) => s + l.total_centavos, 0);
  return linhas.map((l) => ({
    ...l,
    custo_centavos: Math.round(l.custo_centavos),
    lucro_centavos: Math.round(l.total_centavos - l.custo_centavos),
    participacao_bp: total ? Math.round((l.total_centavos / total) * 10_000) : 0,
  }));
}

/**
 * Curva ABC: do produto que mais fatura para o que menos fatura, A são os que completam os primeiros 80%
 * do faturamento, B vai até 95% e C é o restante. A classe olha o acumulado ANTES do produto, então
 * o item que cruza a faixa ainda pertence a ela (o primeiro da lista é sempre A).
 */
function curvaAbc(db, { de, ate }) {
  const linhas = maisVendidos(db, { de, ate, limite: 1000 });
  const total = linhas.reduce((s, l) => s + l.total_centavos, 0);
  let acumulado = 0;
  return linhas.map((l) => {
    const anterior = total ? acumulado / total : 0;
    acumulado += l.total_centavos;
    return {
      ...l,
      acumulado_bp: Math.round((total ? acumulado / total : 0) * 10_000),
      classe: anterior < 0.8 ? 'A' : anterior < 0.95 ? 'B' : 'C',
    };
  });
}

function porCategoria(db, { de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT COALESCE(c.nome, 'Sem categoria') AS categoria, COALESCE(c.cor, '#9AA0AA') AS cor,
      SUM(i.total_centavos) AS total_centavos, SUM(i.qtd_mil * i.custo_centavos / 1000) AS custo_centavos, COUNT(DISTINCT v.id) AS vendas
    FROM venda_itens i JOIN vendas v ON v.id = i.venda_id JOIN produtos p ON p.id = i.produto_id LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE v.status = 'paga' AND v.fechada_em >= ? AND v.fechada_em < ? GROUP BY categoria ORDER BY total_centavos DESC`).all(inicio, fim)
    .map((l) => ({ ...l, custo_centavos: Math.round(l.custo_centavos), lucro_centavos: Math.round(l.total_centavos - l.custo_centavos) }));
}

/** Quanto cada morador consumiu no período (quem mais usa o mercadinho). */
function porMorador(db, { de, ate, limite = 50 }) {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT m.id, m.nome, m.bloco, m.unidade, COUNT(v.id) AS compras, COALESCE(SUM(v.total_centavos), 0) AS total_centavos,
      COALESCE((SELECT SUM(cm.valor_centavos) FROM conta_morador cm WHERE cm.morador_id = m.id), 0) AS saldo_centavos
    FROM vendas v JOIN moradores m ON m.id = v.morador_id
    WHERE v.status = 'paga' AND v.fechada_em >= ? AND v.fechada_em < ?
    GROUP BY m.id ORDER BY total_centavos DESC LIMIT ?`).all(inicio, fim, limite);
}

/** Produtos parados: sem venda no período e com estoque na prateleira. */
function semGiro(db, { de, ate, limite = 50 }) {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT p.id, p.nome, p.unidade, p.estoque_mil, p.custo_centavos, p.preco_centavos,
      (p.estoque_mil * p.custo_centavos / 1000) AS parado_centavos
    FROM produtos p WHERE p.ativo = 1 AND p.estoque_mil > 0 AND p.id NOT IN (
      SELECT i.produto_id FROM venda_itens i JOIN vendas v ON v.id = i.venda_id WHERE v.status = 'paga' AND v.fechada_em >= ? AND v.fechada_em < ?)
    ORDER BY parado_centavos DESC LIMIT ?`).all(inicio, fim, limite)
    .map((l) => ({ ...l, parado_centavos: Math.round(l.parado_centavos) }));
}

/** Perdas e quebras do período (vencidos, avarias e acertos de inventário). */
function perdas(db, { de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT m.id, m.criado_em, m.tipo, m.observacao, ABS(m.qtd_mil) AS qtd_mil, p.nome AS produto, p.unidade,
      ROUND(ABS(m.qtd_mil) * m.custo_centavos / 1000) AS valor_centavos, u.nome AS usuario
    FROM estoque_mov m JOIN produtos p ON p.id = m.produto_id LEFT JOIN usuarios u ON u.id = m.usuario_id
    WHERE m.tipo IN ('perda','inventario') AND m.qtd_mil < 0 AND m.criado_em >= ? AND m.criado_em < ? ORDER BY m.id DESC`).all(inicio, fim);
}

/** Converte uma lista de objetos em CSV (separador ';', como o Excel brasileiro espera). */
function csv(linhas, colunas) {
  const escapar = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const cabecalho = colunas.map((c) => escapar(c.rotulo)).join(';');
  const corpo = linhas.map((l) => colunas.map((c) => escapar(c.valor ? c.valor(l) : l[c.campo])).join(';'));
  return `﻿${[cabecalho, ...corpo].join('\n')}\n`;
}

module.exports = { vendas, maisVendidos, curvaAbc, porCategoria, porMorador, semGiro, perdas, csv };
