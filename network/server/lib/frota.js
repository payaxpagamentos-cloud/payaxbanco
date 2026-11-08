'use strict';

const { agora } = require('../db');
const { ErroNegocio } = require('./erros');

const ATIVOS_OS = ['atribuido', 'em_rota', 'em_execucao'];

const restricoesAtivas = (db, veiculoId) =>
  db.prepare('SELECT * FROM veiculo_restricoes WHERE veiculo_id = ? AND fim IS NULL ORDER BY inicio').all(veiculoId);

/** Estado exibido: o estado escolhido, a menos que uma restrição ativa impeça o uso. */
function statusEfetivo(veiculo, restricoes) {
  if (veiculo.status_base === 'inativo') return 'inativo';
  if (restricoes.some((r) => r.tipo === 'oficina' || r.tipo === 'manutencao')) return 'em_oficina';
  if (restricoes.length) return 'indisponivel';
  return veiculo.status_base;
}

/** O veículo pode receber uma escala? Devolve os motivos de bloqueio (restrições ativas ou veículo inativo). */
function disponibilidade(db, veiculo) {
  const restricoes = restricoesAtivas(db, veiculo.id);
  const motivos = restricoes.map((r) => ({ tipo: r.tipo, motivo: r.motivo, desde: r.inicio, restricao_id: r.id }));
  if (veiculo.status_base === 'inativo') motivos.unshift({ tipo: 'inativo', motivo: 'Veículo inativo.' });
  return { disponivel: motivos.length === 0, status: statusEfetivo(veiculo, restricoes), motivos };
}

/** Impede a escala de veículo indisponível; o erro explica o motivo ao gestor. */
function exigirDisponivel(db, veiculo) {
  const d = disponibilidade(db, veiculo);
  if (!d.disponivel) {
    throw new ErroNegocio(`Veículo ${veiculo.placa} indisponível: ${d.motivos.map((m) => m.motivo).join('; ')}`, 409, { motivos: d.motivos });
  }
  return d;
}

/** Chamados ativos do mesmo veículo ou técnico no mesmo dia (conflito de agenda). */
function conflitosAgenda(db, org, { veiculoId, tecnicoId, dia, ignorarChamado }) {
  if (!dia) return [];
  const f = [];
  const p = [org, `${dia}%`, ignorarChamado ?? -1];
  if (veiculoId) { f.push('veiculo_id = ?'); p.push(veiculoId); }
  if (tecnicoId) { f.push('tecnico_id = ?'); p.push(tecnicoId); }
  if (!f.length) return [];
  return db.prepare(`SELECT id, numero, titulo, status, agendado_para, veiculo_id, tecnico_id FROM chamados WHERE organizacao_id = ?
    AND agendado_para LIKE ? AND id <> ? AND status IN (${ATIVOS_OS.map(() => '?').join(',')}) AND (${f.join(' OR ')})`)
    .all(p[0], p[1], p[2], ...ATIVOS_OS, ...p.slice(3));
}

/** Atualiza o odômetro do veículo quando a nova leitura é maior (leituras menores não regridem o valor). */
function atualizarOdometro(db, veiculoId, km, fonte, em = agora()) {
  if (km === null || km === undefined) return;
  db.prepare(`UPDATE veiculos SET odometro_km = ?, odometro_fonte = ?, odometro_em = ?
    WHERE id = ? AND (odometro_km IS NULL OR odometro_km < ?)`).run(km, fonte, em, veiculoId, km);
}

function abrirRestricao(db, req, veiculoId, { tipo, motivo, ordemId = null }) {
  return Number(db.prepare(`INSERT INTO veiculo_restricoes (organizacao_id, veiculo_id, tipo, motivo, ordem_id, inicio, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.usuario.organizacao_id, veiculoId, tipo, motivo, ordemId, agora(), req.usuario.id).lastInsertRowid);
}

function liberarRestricao(db, req, restricaoId, motivo) {
  db.prepare('UPDATE veiculo_restricoes SET fim = ?, liberado_por = ?, motivo_liberacao = ? WHERE id = ? AND fim IS NULL')
    .run(agora(), req.usuario.id, motivo, restricaoId);
}

module.exports = { restricoesAtivas, statusEfetivo, disponibilidade, exigirDisponivel, conflitosAgenda, atualizarOdometro, abrirRestricao, liberarRestricao, ATIVOS_OS };
