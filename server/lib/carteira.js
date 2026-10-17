'use strict';

const { transacao } = require('../db');
const { CATEGORIAS_PADRAO, ROTINAS_PADRAO } = require('./plano-contas');
const { hoje, somarMeses, somarDias, inicioMes } = require('./datas');
const { naoEncontrado } = require('./erros');
const v = require('./validacao');

/** Primeira data com o dia do mês informado, a partir de hoje. */
function proximoDia(diaDoMes, base = hoje()) {
  const neste = `${base.slice(0, 8)}${String(diaDoMes).padStart(2, '0')}`;
  return neste >= base ? neste : somarMeses(neste, 1);
}

/** Plano de contas, centro de custo "Geral" e rotinas mensais para uma empresa recém-cadastrada. */
function prepararEmpresa(db, empresaId, responsavelId) {
  const cat = db.prepare('INSERT OR IGNORE INTO categorias (empresa_id, nome, tipo, grupo_dre) VALUES (?, ?, ?, ?)');
  for (const [nome, tipo, grupo] of CATEGORIAS_PADRAO) cat.run(empresaId, nome, tipo, grupo);
  db.prepare('INSERT OR IGNORE INTO centros_custo (empresa_id, nome) VALUES (?, ?)').run(empresaId, 'Geral');
  const tarefa = db.prepare("INSERT INTO tarefas (empresa_id, titulo, responsavel_id, vencimento, recorrencia) VALUES (?, ?, ?, ?, 'mensal')");
  for (const [dia, titulo] of ROTINAS_PADRAO) tarefa.run(empresaId, titulo, responsavelId ?? null, proximoDia(dia));
}

/** Conclui a tarefa; se for recorrente, cria a próxima ocorrência. */
function concluirTarefa(db, req, tarefaId, permitida) {
  return transacao(db, () => {
    const t = db.prepare('SELECT * FROM tarefas WHERE id = ?').get(Number(tarefaId));
    if (!t) throw naoEncontrado('Tarefa');
    permitida(t.empresa_id);
    v.exigir(t.status === 'aberta', 'A tarefa não está aberta.');
    db.prepare("UPDATE tarefas SET status = 'concluida', concluida_em = datetime('now'), concluida_por = ? WHERE id = ?").run(req.usuario.id, t.id);
    if (t.recorrencia === 'nenhuma') return { proxima_id: null };
    const proxima = t.recorrencia === 'mensal' ? somarMeses(t.vencimento, 1) : somarDias(t.vencimento, 7);
    const r = db.prepare('INSERT INTO tarefas (empresa_id, titulo, descricao, responsavel_id, vencimento, recorrencia) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t.empresa_id, t.titulo, t.descricao, t.responsavel_id, proxima, t.recorrencia);
    return { proxima_id: Number(r.lastInsertRowid), vencimento: proxima };
  });
}

/** Mensalidade prevista da carteira (MRR) e contratos que vencem em 60 dias. */
function receitaCarteira(db, filtro) {
  const dia = hoje();
  return db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.status IN ('ativa','implantacao') THEN e.mensalidade_centavos END), 0) AS mrr_centavos,
      SUM(e.status IN ('ativa','implantacao')) AS ativas, SUM(e.status = 'implantacao') AS implantacao, SUM(e.status = 'suspensa') AS suspensas,
      SUM(e.status = 'encerrada') AS encerradas,
      SUM(e.status IN ('ativa','implantacao') AND e.fim_contrato BETWEEN ? AND ?) AS contratos_vencendo,
      SUM(e.status IN ('ativa','implantacao') AND e.inicio_contrato >= ?) AS novas_mes
    FROM empresas e WHERE ${filtro.sql}`).get(dia, somarDias(dia, 60), inicioMes(dia), ...filtro.params);
}

module.exports = { prepararEmpresa, concluirTarefa, receitaCarteira, proximoDia };
