'use strict';

const express = require('express');
const config = require('../config');
const { exigir } = require('../auth');
const { csv } = require('../lib/http');
const datas = require('../lib/datas');
const consultas = require('../lib/consultas');
const { podeEquipe } = require('../lib/permissoes');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const periodo = (q) => ({ de: q.de || datas.primeiroDiaMes(hoje()), ate: q.ate || hoje() });

/** Por cliente: o que entrou, o que ficou conosco e o que foi repassado no período. */
function porCliente(db, { de, ate }) {
  return db.prepare(`SELECT c.id, c.razao_social, c.nome_fantasia, c.cnpj, c.situacao,
      (SELECT COUNT(*) FROM boletos b WHERE b.cliente_id = c.id AND b.emissao BETWEEN ?1 AND ?2) AS emitidos,
      (SELECT IFNULL(SUM(b.valor_centavos), 0) FROM boletos b WHERE b.cliente_id = c.id AND b.emissao BETWEEN ?1 AND ?2) AS valor_emitido_centavos,
      (SELECT COUNT(*) FROM boletos b WHERE b.cliente_id = c.id AND b.situacao = 'liquidado' AND b.pago_em BETWEEN ?1 AND ?2) AS liquidados,
      (SELECT IFNULL(SUM(b.pago_valor_centavos), 0) FROM boletos b WHERE b.cliente_id = c.id AND b.situacao = 'liquidado' AND b.pago_em BETWEEN ?1 AND ?2) AS bruto_centavos,
      (SELECT IFNULL(SUM(b.custo_liquidacao_centavos), 0) FROM boletos b WHERE b.cliente_id = c.id AND b.situacao = 'liquidado' AND b.pago_em BETWEEN ?1 AND ?2) AS custo_banco_centavos,
      (SELECT IFNULL(SUM(-l.valor_centavos), 0) FROM lancamentos l WHERE l.cliente_id = c.id AND l.tipo = 'comissao' AND l.data_competencia BETWEEN ?1 AND ?2) AS comissao_centavos,
      (SELECT IFNULL(SUM(-l.valor_centavos), 0) FROM lancamentos l WHERE l.cliente_id = c.id AND l.tipo IN ('tarifa_banco','tarifa_emissao','taxa_repasse') AND l.data_competencia BETWEEN ?1 AND ?2) AS tarifas_centavos,
      (SELECT IFNULL(SUM(-l.valor_centavos), 0) FROM lancamentos l WHERE l.cliente_id = c.id AND l.tipo = 'repasse' AND l.data_competencia BETWEEN ?1 AND ?2) AS repassado_centavos
    FROM clientes c ORDER BY bruto_centavos DESC`).all(de, ate);
}

module.exports = (db) => {
  const r = express.Router();

  /** Nosso faturamento: comissões e tarifas menos o custo do banco. */
  r.get('/faturamento', exigir('relatorios.ver'), (req, res) => {
    const p = periodo(req.query);
    const linhas = porCliente(db, p).map((c) => ({ ...c, receita_centavos: c.comissao_centavos + c.tarifas_centavos,
      margem_centavos: c.comissao_centavos + c.tarifas_centavos - c.custo_banco_centavos }));
    const totais = linhas.reduce((t, c) => ({
      emitidos: t.emitidos + c.emitidos,
      valor_emitido_centavos: t.valor_emitido_centavos + c.valor_emitido_centavos,
      liquidados: t.liquidados + c.liquidados,
      bruto_centavos: t.bruto_centavos + c.bruto_centavos,
      comissao_centavos: t.comissao_centavos + c.comissao_centavos,
      tarifas_centavos: t.tarifas_centavos + c.tarifas_centavos,
      custo_banco_centavos: t.custo_banco_centavos + c.custo_banco_centavos,
      receita_centavos: t.receita_centavos + c.receita_centavos,
      margem_centavos: t.margem_centavos + c.margem_centavos,
      repassado_centavos: t.repassado_centavos + c.repassado_centavos,
    }), { emitidos: 0, valor_emitido_centavos: 0, liquidados: 0, bruto_centavos: 0, comissao_centavos: 0, tarifas_centavos: 0,
      custo_banco_centavos: 0, receita_centavos: 0, margem_centavos: 0, repassado_centavos: 0 });
    const esconderMargem = !podeEquipe(req.usuario.perfil, 'relatorios.margem');
    res.json({
      periodo: p,
      totais: esconderMargem ? { ...totais, custo_banco_centavos: undefined, margem_centavos: undefined } : totais,
      clientes: esconderMargem ? linhas.map((c) => ({ ...c, custo_banco_centavos: undefined, margem_centavos: undefined })) : linhas,
      serie: consultas.serieDiaria(db, p),
      liquidacoes: consultas.resumoLiquidacoes(db, p),
      taxa_conversao: (() => {
        const e = consultas.resumoBoletos(db, { ...p, hoje: hoje() });
        return e.emitidos ? Math.round((e.liquidados / e.emitidos) * 1000) / 10 : null;
      })(),
    });
  });

  r.get('/faturamento.csv', exigir('relatorios.ver'), (req, res) => {
    const p = periodo(req.query);
    const linhas = [['Cliente', 'CNPJ', 'Emitidos', 'Valor emitido (R$)', 'Liquidados', 'Valor recebido (R$)',
      'Tarifa PayAx (R$)', 'Tarifas bancárias (R$)', 'Receita (R$)', 'Repassado (R$)']];
    for (const c of porCliente(db, p)) {
      const reais = (x) => (x / 100).toFixed(2).replace('.', ',');
      linhas.push([c.razao_social, c.cnpj, c.emitidos, reais(c.valor_emitido_centavos), c.liquidados, reais(c.bruto_centavos),
        reais(c.comissao_centavos), reais(c.tarifas_centavos), reais(c.comissao_centavos + c.tarifas_centavos), reais(c.repassado_centavos)]);
    }
    res.type('text/csv; charset=utf-8').attachment(`faturamento-${p.de}-a-${p.ate}.csv`).send(csv(linhas));
  });

  /** Conciliação: avisos do banco recebidos e o que o sistema fez com cada um. */
  r.get('/conciliacao', exigir('conciliacao.ver'), (req, res) => {
    const p = periodo(req.query);
    res.json({
      periodo: p,
      eventos: db.prepare(`SELECT e.id, e.tipo, e.nosso_numero, e.origem, e.recebido_em, e.processado_em, e.resultado, e.erro,
          b.id AS boleto_id, b.pagador_nome, b.valor_centavos, c.razao_social
        FROM eventos_banco e LEFT JOIN boletos b ON b.id = e.boleto_id LEFT JOIN clientes c ON c.id = b.cliente_id
        WHERE date(e.recebido_em) BETWEEN ? AND ? ORDER BY e.id DESC LIMIT 500`).all(p.de, p.ate),
      resumo: db.prepare(`SELECT IFNULL(resultado, 'pendente') AS resultado, COUNT(*) AS n FROM eventos_banco
        WHERE date(recebido_em) BETWEEN ? AND ? GROUP BY IFNULL(resultado, 'pendente')`).all(p.de, p.ate),
      sem_aviso: db.prepare(`SELECT COUNT(*) AS n FROM boletos WHERE situacao = 'registrado' AND vencimento < ?`).get(hoje()).n,
    });
  });

  return r;
};
