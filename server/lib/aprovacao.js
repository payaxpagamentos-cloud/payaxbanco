'use strict';

const { transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const lanc = require('./lancamentos');
const v = require('./validacao');

/**
 * Fluxo: solicitado (lançamento criado) → conferência pela equipe (documento, valor, dados de pagamento)
 * → autorização por quem tem alçada (equipe ou responsável da empresa no Portal) → pagamento.
 * Quem lançou não autoriza o próprio pagamento.
 */

/** Alçada da equipe em centavos: -1 sem limite, 0 não aprova. Sem valor definido, segue o perfil. */
function alcadaUsuario(u) {
  if (u.alcada_aprovacao_centavos !== null && u.alcada_aprovacao_centavos !== undefined) return u.alcada_aprovacao_centavos;
  return ['admin', 'supervisor'].includes(u.perfil) ? -1 : 0;
}
const cabe = (alcada, valor) => alcada === -1 || (alcada > 0 && valor <= alcada);

function historico(db, lancamentoId) {
  return db.prepare(`SELECT a.*, u.nome AS usuario_nome, r.nome AS responsavel_nome FROM aprovacoes a
    LEFT JOIN usuarios u ON u.id = a.usuario_id LEFT JOIN responsaveis r ON r.id = a.responsavel_id
    WHERE a.lancamento_id = ? ORDER BY a.id`).all(lancamentoId);
}

function registrar(db, lancamentoId, etapa, { usuarioId = null, responsavelId = null, comentario = null }) {
  db.prepare('INSERT INTO aprovacoes (lancamento_id, etapa, usuario_id, responsavel_id, comentario) VALUES (?, ?, ?, ?, ?)')
    .run(lancamentoId, etapa, usuarioId, responsavelId, v.texto(comentario, 500));
}

/** Conferência pela equipe: confirma documento e dados; passa para autorização. */
function conferir(db, req, empresaId, id, comentario) {
  return transacao(db, () => {
    const l = lanc.buscar(db, empresaId, id);
    v.exigir(l.status === 'aberto', 'Lançamento não está em aberto.');
    v.exigir(l.aprovacao === 'conferencia', 'Este pagamento não está aguardando conferência.');
    db.prepare("UPDATE lancamentos SET aprovacao = 'pendente' WHERE id = ?").run(l.id);
    registrar(db, l.id, 'conferido', { usuarioId: req.usuario.id, comentario });
  });
}

/**
 * Decide (aprova ou recusa). `quem`: { usuario } da equipe ou { responsavel } do Portal.
 * A recusa exige motivo. A aprovação respeita a alçada e a segregação (quem lançou não aprova).
 */
function decidir(db, quem, empresaId, id, aprovar, comentario) {
  return transacao(db, () => {
    const l = lanc.buscar(db, empresaId, id);
    v.exigir(l.status === 'aberto', 'Lançamento não está em aberto.');
    v.exigir(l.aprovacao === 'pendente', l.aprovacao === 'conferencia' ? 'O pagamento ainda não foi conferido pela equipe.' : 'Este pagamento não está aguardando autorização.');
    if (!aprovar) v.exigir(v.texto(comentario), 'Informe o motivo da recusa.');
    if (quem.usuario) {
      const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(quem.usuario.id);
      if (aprovar && !cabe(alcadaUsuario(u), l.valor_centavos)) throw new ErroNegocio('Valor acima da sua alçada de aprovação.', 403);
      if (aprovar && l.criado_por === u.id) throw new ErroNegocio('Quem lançou o pagamento não pode aprová-lo.', 403);
    } else {
      const r = quem.responsavel;
      if (!r.pode_aprovar) throw new ErroNegocio('Seu acesso não permite aprovar pagamentos.', 403);
      if (aprovar && !cabe(r.limite_aprovacao_centavos, l.valor_centavos)) throw new ErroNegocio('Valor acima do seu limite de aprovação.', 403);
    }
    db.prepare('UPDATE lancamentos SET aprovacao = ? WHERE id = ?').run(aprovar ? 'aprovada' : 'recusada', l.id);
    registrar(db, l.id, aprovar ? 'aprovado' : 'recusado', { usuarioId: quem.usuario?.id, responsavelId: quem.responsavel?.id, comentario });
  });
}

/** Fila de aprovação da empresa. */
function fila(db, empresaId, status = 'abertas') {
  const filtro = status === 'abertas' ? "l.aprovacao IN ('conferencia','pendente')" : 'l.aprovacao = ?';
  const params = status === 'abertas' ? [] : [status];
  return db.prepare(`SELECT l.*, ct.nome AS contato_nome, cat.nome AS categoria_nome, u.nome AS criado_por_nome,
      (SELECT COUNT(*) FROM documentos d WHERE d.lancamento_id = l.id) AS documentos,
      (SELECT a.criado_em FROM aprovacoes a WHERE a.lancamento_id = l.id ORDER BY a.id DESC LIMIT 1) AS ultima_etapa_em
    FROM lancamentos l LEFT JOIN contatos ct ON ct.id = l.contato_id LEFT JOIN categorias cat ON cat.id = l.categoria_id
    LEFT JOIN usuarios u ON u.id = l.criado_por
    WHERE l.empresa_id = ? AND l.tipo = 'pagar' AND l.status <> 'cancelado' AND ${filtro} ORDER BY l.vencimento, l.id LIMIT 300`).all(empresaId, ...params);
}

module.exports = { alcadaUsuario, cabe, historico, conferir, decidir, fila };
