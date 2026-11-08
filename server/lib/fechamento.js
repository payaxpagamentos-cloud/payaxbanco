'use strict';

const { transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');
const { fimMes, hoje } = require('./datas');

/**
 * Etapas do fechamento mensal. As automáticas são conferidas pelo sistema; as manuais, marcadas
 * pela equipe. Com todas concluídas, o mês pode ser fechado — e passa a não aceitar alterações.
 */
const ETAPAS = [
  { chave: 'conciliacao', rotulo: 'Extratos importados e conciliados até o fim do mês', auto: true },
  { chave: 'vencidos', rotulo: 'Contas vencidas no mês baixadas ou justificadas', auto: true },
  { chave: 'aprovacoes', rotulo: 'Nenhum pagamento do mês aguardando aprovação', auto: true },
  { chave: 'classificacao', rotulo: 'Lançamentos do mês revisados (categoria e centro de custo)', auto: false },
  { chave: 'dre', rotulo: 'DRE e fluxo de caixa revisados', auto: false },
  { chave: 'envio', rotulo: 'Relatórios enviados ao cliente', auto: false },
];

function verificacoes(db, empresaId, mes) {
  const fim = fimMes(`${mes}-01`);
  const contas = db.prepare('SELECT id, descricao FROM contas_bancarias WHERE empresa_id = ? AND ativo = 1').all(empresaId);
  const semExtrato = contas.filter((c) => !db.prepare('SELECT 1 FROM extrato WHERE conta_bancaria_id = ? AND data >= ?').get(c.id, fim));
  const pendentesExtrato = db.prepare("SELECT COUNT(*) AS n FROM extrato WHERE empresa_id = ? AND status = 'pendente' AND data <= ?").get(empresaId, fim).n;
  const vencidos = db.prepare("SELECT COUNT(*) AS n FROM lancamentos WHERE empresa_id = ? AND status = 'aberto' AND vencimento BETWEEN ? AND ?").get(empresaId, `${mes}-01`, fim).n;
  const aprovacoes = db.prepare("SELECT COUNT(*) AS n FROM lancamentos WHERE empresa_id = ? AND status = 'aberto' AND aprovacao IN ('conferencia','pendente') AND vencimento <= ?").get(empresaId, fim).n;
  return {
    conciliacao: {
      ok: contas.length > 0 && !semExtrato.length && !pendentesExtrato,
      detalhe: !contas.length ? 'Nenhuma conta bancária ativa.'
        : semExtrato.length ? `Extrato não cobre o mês: ${semExtrato.map((c) => c.descricao).join(', ')}.`
          : pendentesExtrato ? `${pendentesExtrato} linha(s) de extrato a conciliar.` : 'Tudo conciliado.',
    },
    // Em aberto e vencido no mês pode ser legítimo (cliente inadimplente): a etapa avisa, mas pode ser marcada.
    vencidos: { ok: !vencidos, detalhe: vencidos ? `${vencidos} conta(s) do mês ainda em aberto.` : 'Nenhuma conta do mês em aberto.' },
    aprovacoes: { ok: !aprovacoes, detalhe: aprovacoes ? `${aprovacoes} pagamento(s) aguardando aprovação.` : 'Nada aguardando aprovação.' },
  };
}

function situacao(db, empresaId, mes) {
  v.exigir(/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes)), 'Mês inválido (AAAA-MM).');
  const feitas = Object.fromEntries(db.prepare(`SELECT f.etapa, f.concluido_em, f.observacao, u.nome AS usuario_nome FROM fechamentos f
    LEFT JOIN usuarios u ON u.id = f.usuario_id WHERE f.empresa_id = ? AND f.mes = ?`).all(empresaId, mes).map((f) => [f.etapa, f]));
  const auto = verificacoes(db, empresaId, mes);
  const etapas = ETAPAS.map((e) => ({ ...e, concluida: feitas[e.chave] ?? null, verificacao: auto[e.chave] ?? null }));
  return {
    mes, etapas,
    fechado: feitas.fechado ?? null,
    progresso: etapas.filter((e) => e.concluida).length / etapas.length,
    pode_fechar: etapas.every((e) => e.concluida) && fimMes(`${mes}-01`) < hoje(),
  };
}

/** Marca ou desmarca uma etapa. Etapa automática só é marcada com a verificação ok ou com observação. */
function marcar(db, req, empresaId, mes, etapa, concluir, observacao) {
  const s = situacao(db, empresaId, mes);
  if (s.fechado) throw new ErroNegocio('Mês fechado: reabra para alterar as etapas.', 409);
  const e = s.etapas.find((x) => x.chave === etapa);
  v.exigir(e, 'Etapa inválida.');
  if (!concluir) {
    db.prepare('DELETE FROM fechamentos WHERE empresa_id = ? AND mes = ? AND etapa = ?').run(empresaId, mes, etapa);
    return;
  }
  if (e.verificacao && !e.verificacao.ok) v.exigir(v.texto(observacao), `${e.verificacao.detalhe} Para concluir assim, explique na observação.`);
  db.prepare(`INSERT INTO fechamentos (empresa_id, mes, etapa, usuario_id, observacao) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (empresa_id, mes, etapa) DO UPDATE SET usuario_id = excluded.usuario_id, observacao = excluded.observacao, concluido_em = datetime('now')`)
    .run(empresaId, mes, etapa, req.usuario.id, v.texto(observacao, 500));
}

function fechar(db, req, empresaId, mes) {
  const s = situacao(db, empresaId, mes);
  v.exigir(!s.fechado, 'Mês já fechado.');
  v.exigir(fimMes(`${mes}-01`) < hoje(), 'Só é possível fechar um mês que já terminou.');
  v.exigir(s.pode_fechar, 'Conclua todas as etapas antes de fechar o mês.');
  // Meses anteriores precisam estar fechados antes (evita alterações "atrás" de um mês fechado).
  // Conta só a partir do início do contrato: o histórico anterior ao BPO não precisa ser fechado.
  const inicio = db.prepare('SELECT substr(inicio_contrato, 1, 7) AS m FROM empresas WHERE id = ?').get(empresaId).m;
  const anteriorAberto = db.prepare(`SELECT MIN(substr(competencia, 1, 7)) AS mes FROM lancamentos l WHERE l.empresa_id = ?
    AND substr(l.competencia, 1, 7) >= ? AND substr(l.competencia, 1, 7) < ?
    AND NOT EXISTS (SELECT 1 FROM fechamentos f WHERE f.empresa_id = l.empresa_id AND f.mes = substr(l.competencia, 1, 7) AND f.etapa = 'fechado')`).get(empresaId, inicio, mes).mes;
  v.exigir(!anteriorAberto, `Feche antes o mês ${anteriorAberto?.slice(5)}/${anteriorAberto?.slice(0, 4)}.`);
  db.prepare("INSERT INTO fechamentos (empresa_id, mes, etapa, usuario_id) VALUES (?, ?, 'fechado', ?)").run(empresaId, mes, req.usuario.id);
}

/** Reabre o mês (e os posteriores já fechados). Só supervisor e administrador, com motivo. */
function reabrir(db, req, empresaId, mes, motivo) {
  if (!['admin', 'supervisor'].includes(req.usuario.perfil)) throw new ErroNegocio('Só supervisor ou administrador reabre um mês fechado.', 403);
  v.exigir(v.texto(motivo), 'Informe o motivo da reabertura.');
  return transacao(db, () => db.prepare("DELETE FROM fechamentos WHERE empresa_id = ? AND mes >= ? AND etapa = 'fechado'").run(empresaId, mes).changes);
}

/** Visão da carteira: progresso do fechamento de cada empresa no mês. */
function carteira(db, empresas, mes) {
  return empresas.map((e) => {
    const s = situacao(db, e.id, mes);
    return { id: e.id, nome: e.nome_fantasia || e.razao_social, analista_nome: e.analista_nome, fechado: Boolean(s.fechado), fechado_em: s.fechado?.concluido_em ?? null,
      progresso: s.progresso, etapas: s.etapas.map((x) => ({ chave: x.chave, concluida: Boolean(x.concluida), ok: x.verificacao ? x.verificacao.ok : null })) };
  });
}

module.exports = { ETAPAS, situacao, marcar, fechar, reabrir, carteira };
