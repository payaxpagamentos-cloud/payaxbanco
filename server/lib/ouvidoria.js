'use strict';

/*
 * Ouvidoria: fila de análise para ações sensíveis. Quando uma ação exige análise, quem pede (equipe ou o
 * próprio cliente, no Internet Banking) abre uma solicitação com protocolo; a Ouvidoria aprova (a ação é
 * executada naquele momento) ou recusa com parecer. Quem pediu nunca decide o próprio pedido.
 * O administrador escolhe, na tela Alçadas, quais ações exigem análise.
 */

const { ErroNegocio, naoEncontrado } = require('./erros');
const { registrar } = require('./auditoria');
const alcadas = require('./alcadas');
const situacao = require('./situacao');
const v = require('./validacao');

const ACOES = [
  { acao: 'encerrar_conta', rotulo: 'Encerramento de conta', padrao: true },
  { acao: 'bloquear_conta', rotulo: 'Bloqueio de conta', padrao: true },
  { acao: 'desbloquear_conta', rotulo: 'Desbloqueio de conta', padrao: true },
  { acao: 'bloquear_cliente', rotulo: 'Bloqueio ou inativação de cliente', padrao: true },
  { acao: 'desbloquear_cliente', rotulo: 'Reativação de cliente', padrao: true },
  { acao: 'excluir_cliente', rotulo: 'Exclusão de cliente', padrao: true },
  { acao: 'bloquear_ib', rotulo: 'Bloqueio do acesso ao Internet Banking', padrao: false },
  { acao: 'desbloquear_ib', rotulo: 'Desbloqueio do acesso ao Internet Banking', padrao: false },
];
const POR_ACAO = new Map(ACOES.map((a) => [a.acao, a]));
const rotulo = (acao) => POR_ACAO.get(acao)?.rotulo ?? acao;

// ---------- Regras: quais ações exigem análise ----------
function exigeAnalise(db, acao) {
  const a = POR_ACAO.get(acao);
  if (!a) return false;
  const r = db.prepare('SELECT exige FROM regras_analise WHERE acao = ?').get(acao);
  return r ? Boolean(r.exige) : a.padrao;
}

const listarRegras = (db) => ACOES.map((a) => ({ acao: a.acao, rotulo: a.rotulo, exige: exigeAnalise(db, a.acao), padrao: a.padrao }));

function salvarRegras(db, usuarioId, regras) {
  const mudancas = [];
  for (const [acao, exige] of Object.entries(regras ?? {})) {
    if (!POR_ACAO.has(acao)) throw new ErroNegocio(`Ação desconhecida: ${acao}.`, 422);
    const atual = exigeAnalise(db, acao);
    if (atual === Boolean(exige)) continue;
    db.prepare(`INSERT INTO regras_analise (acao, exige, atualizado_por, atualizado_em) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (acao) DO UPDATE SET exige = excluded.exige, atualizado_por = excluded.atualizado_por, atualizado_em = excluded.atualizado_em`)
      .run(acao, exige ? 1 : 0, usuarioId);
    mudancas.push({ acao, de: atual, para: Boolean(exige) });
  }
  return mudancas;
}

const restaurarRegras = (db) => db.prepare('DELETE FROM regras_analise').run();

// ---------- Solicitações ----------
const SELECT = `SELECT s.*, cl.nome AS cliente_nome_atual, cl.documento AS cliente_documento,
    c.agencia, c.numero || '-' || c.digito AS conta_numero, c.status AS conta_status,
    us.nome AS solicitante_nome, ud.nome AS decisor_nome
  FROM solicitacoes s
  LEFT JOIN clientes cl ON cl.id = s.cliente_id
  LEFT JOIN contas c ON c.id = s.conta_id
  LEFT JOIN usuarios us ON us.id = s.solicitante_id
  LEFT JOIN usuarios ud ON ud.id = s.decidido_por`;

function formatar(s) {
  if (!s) return s;
  return { ...s, dados: s.dados ? JSON.parse(s.dados) : {}, tipo_rotulo: rotulo(s.tipo), cliente_nome: s.cliente_nome_atual ?? s.cliente_nome };
}

function detalhar(db, id) {
  const s = formatar(db.prepare(`${SELECT} WHERE s.id = ?`).get(id));
  if (!s) throw naoEncontrado('Solicitação');
  return s;
}

function listar(db, filtros = {}) {
  const where = [];
  const params = [];
  if (filtros.status) { where.push('s.status = ?'); params.push(filtros.status); }
  if (filtros.conta_id) { where.push('s.conta_id = ?'); params.push(filtros.conta_id); }
  if (filtros.cliente_id) { where.push('s.cliente_id = ?'); params.push(filtros.cliente_id); }
  return db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.status = 'em_analise' DESC, s.id DESC LIMIT 300`)
    .all(...params).map(formatar);
}

/** Abre a solicitação. `alvo`: { clienteId, contaId? }. `dados`: o que será aplicado na aprovação (ex.: { status }). */
function criar(db, req, { tipo, clienteId, contaId = null, dados = {}, motivo, origem }) {
  v.exigir(POR_ACAO.has(tipo), 'Tipo de solicitação inválido.');
  const texto = v.texto(motivo, 1000);
  v.exigir(texto && texto.length >= 5, 'Informe o motivo: a solicitação vai para análise da Ouvidoria.');
  const cliente = situacao.buscarCliente(db, clienteId);
  const pendente = db.prepare(`SELECT protocolo FROM solicitacoes WHERE status = 'em_analise' AND tipo = ? AND cliente_id = ? AND IFNULL(conta_id, 0) = IFNULL(?, 0)`)
    .get(tipo, cliente.id, contaId);
  if (pendente) throw new ErroNegocio(`Já existe uma solicitação em análise na Ouvidoria (protocolo ${pendente.protocolo}).`, 409);
  const ins = db.prepare(`INSERT INTO solicitacoes (protocolo, tipo, cliente_id, cliente_nome, conta_id, dados, motivo, origem, solicitante_id)
    VALUES ('pendente-' || hex(randomblob(8)), ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(tipo, cliente.id, cliente.nome, contaId, JSON.stringify(dados), texto, origem, req.usuario?.id ?? null);
  const id = Number(ins.lastInsertRowid);
  const protocolo = `OUV-${new Date().getFullYear()}-${String(id).padStart(6, '0')}`;
  db.prepare('UPDATE solicitacoes SET protocolo = ? WHERE id = ?').run(protocolo, id);
  registrar(db, req, 'solicitar_analise', 'solicitacao', id, { protocolo, tipo, conta_id: contaId, cliente_id: cliente.id });
  return detalhar(db, id);
}

/** Executa a ação aprovada, em nome de quem aprovou (a auditoria guarda o protocolo). */
function executar(db, req, s) {
  const extra = { protocolo: s.protocolo, motivo: s.motivo };
  switch (s.tipo) {
    case 'encerrar_conta': case 'bloquear_conta': case 'desbloquear_conta':
      situacao.alterarStatusConta(db, req, s.conta_id, s.dados.status, extra); break;
    case 'bloquear_cliente': case 'desbloquear_cliente':
      situacao.alterarStatusCliente(db, req, s.cliente_id, s.dados.status, extra); break;
    case 'bloquear_ib': case 'desbloquear_ib':
      situacao.alterarStatusIb(db, req, s.cliente_id, s.dados.status, extra); break;
    case 'excluir_cliente':
      situacao.excluirCliente(db, req, s.cliente_id, extra); break;
    default: throw new ErroNegocio('Tipo de solicitação inválido.', 422);
  }
}

function decidir(db, req, id, { aprovar, parecer }) {
  alcadas.exigir(db, req, 'ouvidoria.decidir');
  const s = detalhar(db, id);
  if (s.status !== 'em_analise') throw new ErroNegocio('Esta solicitação já foi decidida.', 409);
  if (s.solicitante_id && s.solicitante_id === req.usuario.id) throw new ErroNegocio('Quem fez a solicitação não pode decidi-la.', 403);
  const texto = v.texto(parecer, 1000);
  if (!aprovar) v.exigir(texto && texto.length >= 5, 'Informe o parecer da recusa.');
  if (aprovar) executar(db, req, s);
  db.prepare(`UPDATE solicitacoes SET status = ?, parecer = ?, decidido_por = ?, decidido_em = datetime('now') WHERE id = ?`)
    .run(aprovar ? 'aprovada' : 'recusada', texto, req.usuario.id, s.id);
  registrar(db, req, aprovar ? 'aprovar_solicitacao' : 'recusar_solicitacao', 'solicitacao', s.id, { protocolo: s.protocolo, tipo: s.tipo, parecer: texto });
  return detalhar(db, s.id);
}

function cancelar(db, req, id) {
  const s = detalhar(db, id);
  if (s.status !== 'em_analise') throw new ErroNegocio('Só é possível cancelar solicitações em análise.', 409);
  const proprio = req.usuario ? s.solicitante_id === req.usuario.id : s.origem === 'cliente' && s.cliente_id === req.cliente?.id;
  if (!proprio && req.usuario?.perfil !== 'admin') throw new ErroNegocio('Só quem fez a solicitação pode cancelá-la.', 403);
  db.prepare("UPDATE solicitacoes SET status = 'cancelada', decidido_por = ?, decidido_em = datetime('now') WHERE id = ?").run(req.usuario?.id ?? null, s.id);
  registrar(db, req, 'cancelar_solicitacao', 'solicitacao', s.id, { protocolo: s.protocolo });
  return detalhar(db, s.id);
}

module.exports = { ACOES, rotulo, exigeAnalise, listarRegras, salvarRegras, restaurarRegras, criar, listar, detalhar, decidir, cancelar };
