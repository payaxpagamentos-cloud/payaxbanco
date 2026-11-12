'use strict';

const { Router } = require('express');
const estoqueLib = require('../lib/estoque');
const financeiro = require('../lib/financeiro');
const caixaLib = require('../lib/caixa');
const relatorios = require('../lib/relatorios');
const { hoje, somarDias, intervalo } = require('../lib/datas');

/** Tudo o que a tela inicial mostra, numa chamada só. */
module.exports = (db) => {
  const r = Router();

  r.get('/', (req, res) => {
    const dia = hoje();
    const [inicio, fim] = intervalo(dia, dia);
    const vendasHoje = db.prepare(`SELECT COUNT(*) AS vendas, COALESCE(SUM(total_centavos), 0) AS total, COALESCE(SUM(custo_centavos), 0) AS custo
      FROM vendas WHERE status = 'paga' AND fechada_em >= ? AND fechada_em < ?`).get(inicio, fim);
    const alertas = estoqueLib.alertas(db);
    const caixa = caixaLib.abertoDo(db, req.usuario.id);
    const devedores = db.prepare(`SELECT COUNT(*) AS moradores, COALESCE(SUM(saldo), 0) AS total FROM (
      SELECT morador_id, SUM(valor_centavos) AS saldo FROM conta_morador GROUP BY morador_id HAVING saldo > 0)`).get();

    res.json({
      dia,
      vendas_hoje: {
        vendas: vendasHoje.vendas,
        total_centavos: vendasHoje.total,
        lucro_centavos: vendasHoje.total - vendasHoje.custo,
        ticket_medio_centavos: vendasHoje.vendas ? Math.round(vendasHoje.total / vendasHoje.vendas) : 0,
      },
      caixa: caixa ? caixaLib.resumo(db, caixa.id) : null,
      caixas_abertos: caixaLib.abertos(db).length,
      estoque: {
        valor: estoqueLib.valorEstoque(db),
        baixo: alertas.estoque_baixo.length,
        sem_estoque: alertas.sem_estoque,
        vencidos: alertas.vencidos.length,
        vencendo: alertas.vencendo.length,
        lista_baixo: alertas.estoque_baixo.slice(0, 8),
        lista_vencendo: [...alertas.vencidos, ...alertas.vencendo].slice(0, 8),
      },
      financeiro: financeiro.resumo(db),
      moradores_devedores: devedores,
      ultimos_7_dias: relatorios.vendas(db, { de: somarDias(dia, -6), ate: dia }),
      mais_vendidos: relatorios.maisVendidos(db, { de: somarDias(dia, -29), ate: dia, limite: 5 }),
      ultimas_vendas: db.prepare(`SELECT v.id, v.total_centavos, v.fechada_em, u.nome AS operador, m.nome AS morador
        FROM vendas v LEFT JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN moradores m ON m.id = v.morador_id
        WHERE v.status = 'paga' ORDER BY v.id DESC LIMIT 8`).all(),
    });
  });

  return r;
};
