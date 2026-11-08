'use strict';

const lanc = require('./lancamentos');
const rel = require('./relatorios');
const { hoje, somarDias, inicioMes, fimMes } = require('./datas');

/**
 * Alerta de falta de caixa: projeta o saldo dia a dia (saldo atual das contas ativas + contas em aberto;
 * vencidas contam para hoje) e devolve o primeiro dia em que fica negativo.
 */
function alertaCaixa(db, empresaId, dias = 30) {
  const dia = hoje();
  const limite = somarDias(dia, dias);
  let saldo = lanc.saldos(db, empresaId).filter((c) => c.ativo).reduce((a, c) => a + c.saldo_centavos, 0);
  const eventos = db.prepare(`SELECT MAX(vencimento, ?) AS data, SUM(CASE WHEN tipo = 'receber' THEN valor_centavos ELSE -valor_centavos END) AS valor
    FROM lancamentos WHERE empresa_id = ? AND status = 'aberto' AND vencimento <= ? GROUP BY MAX(vencimento, ?) ORDER BY 1`).all(dia, empresaId, limite, dia);
  let menor = { data: dia, saldo_centavos: saldo };
  for (const e of eventos) {
    saldo += e.valor;
    if (saldo < menor.saldo_centavos) menor = { data: e.data, saldo_centavos: saldo };
    if (saldo < 0) return { falta: true, data: e.data, saldo_centavos: saldo, dias, menor };
  }
  return { falta: false, data: null, saldo_centavos: saldo, dias, menor };
}

/** Posição financeira da empresa: saldos, a pagar e a receber, inadimplência, alertas. */
function resumoEmpresa(db, empresaId) {
  const dia = hoje();
  const soma = (tipo, cond, ...p) => db.prepare(`SELECT COUNT(*) AS quantidade, COALESCE(SUM(valor_centavos), 0) AS total_centavos FROM lancamentos
    WHERE empresa_id = ? AND tipo = ? AND status = 'aberto' AND ${cond}`).get(empresaId, tipo, ...p);
  const contas = lanc.saldos(db, empresaId);
  const proximos = db.prepare(`SELECT l.*, c.nome AS contato_nome FROM lancamentos l LEFT JOIN contatos c ON c.id = l.contato_id
    WHERE l.empresa_id = ? AND l.status = 'aberto' AND l.vencimento <= ? ORDER BY l.vencimento, l.id LIMIT 15`).all(empresaId, somarDias(dia, 7))
    .map((l) => ({ ...l, situacao: lanc.situacao(l, dia) }));
  const mesAtual = rel.dre(db, empresaId, { de: inicioMes(dia), ate: fimMes(dia) });
  const baseInad = db.prepare(`SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM lancamentos WHERE empresa_id = ? AND tipo = 'receber'
    AND status <> 'cancelado' AND vencimento BETWEEN ? AND ?`).get(empresaId, somarDias(dia, -90), somarDias(dia, -1)).s;
  const vencido90 = db.prepare(`SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM lancamentos WHERE empresa_id = ? AND tipo = 'receber'
    AND status = 'aberto' AND vencimento BETWEEN ? AND ?`).get(empresaId, somarDias(dia, -90), somarDias(dia, -1)).s;
  const receberVencidos = soma('receber', 'vencimento < ?', dia);
  return {
    hoje: dia,
    saldo_total_centavos: contas.filter((c) => c.ativo).reduce((a, c) => a + c.saldo_centavos, 0),
    contas,
    pagar: { vencidos: soma('pagar', 'vencimento < ?', dia), hoje: soma('pagar', 'vencimento = ?', dia), semana: soma('pagar', 'vencimento > ? AND vencimento <= ?', dia, somarDias(dia, 7)) },
    receber: { vencidos: receberVencidos, hoje: soma('receber', 'vencimento = ?', dia), semana: soma('receber', 'vencimento > ? AND vencimento <= ?', dia, somarDias(dia, 7)) },
    inadimplencia: { vencido_centavos: receberVencidos.total_centavos, titulos: receberVencidos.quantidade, taxa_90_dias: baseInad ? vencido90 / baseInad : null },
    alerta_caixa: alertaCaixa(db, empresaId),
    aprovacoes_pendentes: db.prepare("SELECT COUNT(*) AS n FROM lancamentos WHERE empresa_id = ? AND status = 'aberto' AND aprovacao IN ('conferencia','pendente')").get(empresaId).n,
    proximos,
    resultado_mes: mesAtual.indicadores,
    extrato_pendente: contas.reduce((a, c) => a + c.extrato_pendente, 0),
  };
}

module.exports = { alertaCaixa, resumoEmpresa };
