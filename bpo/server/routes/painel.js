'use strict';

const { Router } = require('express');
const { filtroCarteira, veTodas } = require('../lib/acesso');
const { receitaCarteira } = require('../lib/carteira');
const { hoje, somarDias } = require('../lib/datas');

/** Painel da carteira: contratos, rotinas e pendências financeiras de todas as empresas visíveis. */
module.exports = (db) => {
  const r = Router();
  r.get('/', (req, res) => {
    const f = filtroCarteira(req.usuario);
    const dia = hoje();
    const semana = somarDias(dia, 7);
    const ativas = `${f.sql} AND e.status IN ('ativa','implantacao')`;

    const tarefas = db.prepare(`SELECT SUM(t.vencimento < ?) AS atrasadas, SUM(t.vencimento = ?) AS hoje, SUM(t.vencimento > ? AND t.vencimento <= ?) AS semana
      FROM tarefas t JOIN empresas e ON e.id = t.empresa_id WHERE t.status = 'aberta' AND ${ativas}`).get(dia, dia, dia, semana, ...f.params);

    const proximas = db.prepare(`SELECT t.id, t.titulo, t.vencimento, t.empresa_id, COALESCE(e.nome_fantasia, e.razao_social) AS empresa_nome, u.nome AS responsavel_nome
      FROM tarefas t JOIN empresas e ON e.id = t.empresa_id LEFT JOIN usuarios u ON u.id = t.responsavel_id
      WHERE t.status = 'aberta' AND t.vencimento <= ? AND ${ativas} ORDER BY t.vencimento, t.id LIMIT 12`).all(semana, ...f.params);

    // Pendências por empresa: o que o analista precisa olhar hoje.
    const pendencias = db.prepare(`SELECT e.id, COALESCE(e.nome_fantasia, e.razao_social) AS nome, u.nome AS analista_nome,
        (SELECT COUNT(*) FROM lancamentos l WHERE l.empresa_id = e.id AND l.status = 'aberto' AND l.tipo = 'pagar' AND l.vencimento = ?) AS pagar_hoje,
        (SELECT COALESCE(SUM(valor_centavos), 0) FROM lancamentos l WHERE l.empresa_id = e.id AND l.status = 'aberto' AND l.tipo = 'pagar' AND l.vencimento = ?) AS pagar_hoje_centavos,
        (SELECT COUNT(*) FROM lancamentos l WHERE l.empresa_id = e.id AND l.status = 'aberto' AND l.tipo = 'pagar' AND l.vencimento < ?) AS pagar_vencidos,
        (SELECT COUNT(*) FROM lancamentos l WHERE l.empresa_id = e.id AND l.status = 'aberto' AND l.tipo = 'receber' AND l.vencimento < ?) AS receber_vencidos,
        (SELECT COUNT(*) FROM extrato x WHERE x.empresa_id = e.id AND x.status = 'pendente') AS extrato_pendente,
        (SELECT MAX(x.data) FROM extrato x WHERE x.empresa_id = e.id) AS ultimo_extrato,
        (SELECT COUNT(*) FROM tarefas t WHERE t.empresa_id = e.id AND t.status = 'aberta' AND t.vencimento < ?) AS tarefas_atrasadas
      FROM empresas e LEFT JOIN usuarios u ON u.id = e.analista_id WHERE ${ativas}
      ORDER BY COALESCE(e.nome_fantasia, e.razao_social)`).all(dia, dia, dia, dia, dia, ...f.params)
      .map((p) => ({ ...p, pontos: p.pagar_hoje + p.pagar_vencidos * 2 + p.receber_vencidos + Math.min(p.extrato_pendente, 20) + p.tarefas_atrasadas * 2 }))
      .sort((a, b) => b.pontos - a.pontos);

    const porAnalista = veTodas(req.usuario)
      ? db.prepare(`SELECT u.id, u.nome, COUNT(e.id) AS empresas, COALESCE(SUM(e.mensalidade_centavos), 0) AS mrr_centavos,
          (SELECT COUNT(*) FROM tarefas t JOIN empresas e2 ON e2.id = t.empresa_id WHERE t.status = 'aberta' AND t.vencimento < ? AND e2.analista_id = u.id
             AND e2.status IN ('ativa','implantacao')) AS tarefas_atrasadas
        FROM usuarios u LEFT JOIN empresas e ON e.analista_id = u.id AND e.status IN ('ativa','implantacao')
        WHERE u.ativo = 1 GROUP BY u.id HAVING empresas > 0 OR u.perfil = 'analista' ORDER BY empresas DESC, u.nome`).all(dia)
      : null;

    res.json({ hoje: dia, carteira: receitaCarteira(db, f), tarefas, proximas, pendencias, por_analista: porAnalista });
  });
  return r;
};
