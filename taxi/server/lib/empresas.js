'use strict';

const { transacao, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { local, intervalo, somarDias } = require('./datas');
const v = require('./validacao');

/** Primeiro e último dia ('AAAA-MM-DD') da competência 'AAAA-MM'. */
function diasDoMes(competencia) {
  v.exigir(/^\d{4}-(0[1-9]|1[0-2])$/.test(String(competencia ?? '')), 'Competência inválida (use AAAA-MM).');
  const [a, m] = competencia.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return [`${competencia}-01`, `${competencia}-${String(ultimo).padStart(2, '0')}`];
}

/** Quanto já foi gasto no mês corrente pela empresa (ou por um usuário nela): corridas finalizadas e as em curso pela estimativa. */
function gastoNoMes(db, empresaId, usuarioId = null) {
  const [ini, fim] = intervalo(...diasDoMes(local().data.slice(0, 7)));
  return db.prepare(`SELECT COALESCE(SUM(COALESCE(valor_final_centavos, valor_estimado_centavos)), 0) AS s FROM corridas
    WHERE empresa_id = ? AND (? IS NULL OR passageiro_id = ?) AND status <> 'cancelada' AND criada_em >= ? AND criada_em < ?`)
    .get(empresaId, usuarioId, usuarioId, ini, fim).s;
}

/** Empresas pelas quais o passageiro está autorizado a pedir, com o quanto ainda pode gastar no mês. */
function autorizadas(db, usuarioId) {
  return db.prepare(`SELECT e.id, e.razao_social, e.limite_mensal_centavos AS limite_empresa, eu.limite_mensal_centavos AS limite_usuario, eu.centro_custo
    FROM empresa_usuarios eu JOIN empresas e ON e.id = eu.empresa_id WHERE eu.usuario_id = ? AND eu.ativo = 1 AND e.ativa = 1 ORDER BY e.razao_social`)
    .all(usuarioId).map((e) => {
      const restante = [
        e.limite_usuario === null ? null : e.limite_usuario - gastoNoMes(db, e.id, usuarioId),
        e.limite_empresa === null ? null : e.limite_empresa - gastoNoMes(db, e.id),
      ].filter((x) => x !== null);
      return { id: e.id, razao_social: e.razao_social, centro_custo: e.centro_custo, disponivel_centavos: restante.length ? Math.max(0, Math.min(...restante)) : null };
    });
}

/** Confere se o passageiro pode pedir esta corrida pela empresa (autorização da gestão e limites do mês). */
function exigirAutorizacao(db, usuarioId, empresaId, valorEstimado) {
  const e = autorizadas(db, usuarioId).find((x) => x.id === Number(empresaId));
  if (!e) throw new ErroNegocio('Você não está autorizado a pedir corridas por esta empresa. Fale com o gestor da sua empresa.', 403);
  if (e.disponivel_centavos !== null && valorEstimado > e.disponivel_centavos) {
    throw new ErroNegocio('Limite mensal de corridas pela empresa atingido. Escolha PIX ou cartão.', 403);
  }
  return e;
}

function buscar(db, id) {
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(id);
  if (!e) throw naoEncontrado('Empresa');
  return e;
}

/**
 * Fecha a fatura da competência: junta as corridas finalizadas pela empresa no mês e ainda não faturadas.
 * Vencimento no dia configurado do mês seguinte.
 */
function gerarFatura(db, usuario, empresaId, competencia) {
  const e = buscar(db, empresaId);
  const [de, ate] = diasDoMes(competencia);
  const [ini, fim] = intervalo(de, ate);
  return transacao(db, () => {
    if (db.prepare("SELECT 1 FROM faturas WHERE empresa_id = ? AND competencia = ? AND status <> 'cancelada'").get(e.id, competencia)) {
      throw new ErroNegocio('Já existe fatura desta empresa para esta competência.', 409);
    }
    const corridas = db.prepare(`SELECT id, valor_final_centavos FROM corridas WHERE empresa_id = ? AND status = 'finalizada' AND fatura_id IS NULL
      AND finalizada_em >= ? AND finalizada_em < ?`).all(e.id, ini, fim);
    v.exigir(corridas.length, 'Nenhuma corrida a faturar nesta competência.');
    const total = corridas.reduce((a, c) => a + c.valor_final_centavos, 0);
    const vencimento = `${somarDias(ate, 1).slice(0, 7)}-${String(e.dia_vencimento).padStart(2, '0')}`;
    db.prepare("DELETE FROM faturas WHERE empresa_id = ? AND competencia = ? AND status = 'cancelada'").run(e.id, competencia);
    const r = db.prepare(`INSERT INTO faturas (empresa_id, competencia, corridas, valor_centavos, vencimento, criada_em, criada_por) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(e.id, competencia, corridas.length, total, vencimento, agora(), usuario.id);
    const id = Number(r.lastInsertRowid);
    const marcar = db.prepare('UPDATE corridas SET fatura_id = ? WHERE id = ?');
    for (const c of corridas) marcar.run(id, c.id);
    return { id, corridas: corridas.length, valor_centavos: total, vencimento };
  });
}

/** Corridas de uma fatura (ou da empresa no mês), com passageiro e centro de custo, para conferência e CSV. */
function corridasDaEmpresa(db, empresaId, { faturaId, competencia }) {
  const filtro = faturaId ? 'c.fatura_id = ?' : 'c.finalizada_em >= ? AND c.finalizada_em < ?';
  const args = faturaId ? [faturaId] : intervalo(...diasDoMes(competencia));
  return db.prepare(`SELECT c.id, c.finalizada_em, c.origem_endereco, c.destino_endereco, c.distancia_percorrida_m, c.valor_final_centavos, c.fatura_id,
      u.nome AS passageiro, u.email, eu.centro_custo
    FROM corridas c JOIN usuarios u ON u.id = c.passageiro_id LEFT JOIN empresa_usuarios eu ON eu.empresa_id = c.empresa_id AND eu.usuario_id = c.passageiro_id
    WHERE c.empresa_id = ? AND c.status = 'finalizada' AND ${filtro} ORDER BY c.finalizada_em`).all(empresaId, ...args);
}

module.exports = { diasDoMes, gastoNoMes, autorizadas, exigirAutorizacao, buscar, gerarFatura, corridasDaEmpresa };
