'use strict';

const { agora } = require('../db');
const { local } = require('./datas');
const { ErroNegocio } = require('./erros');

/**
 * Filas são os departamentos que recebem o que a ZOE não resolve
 * (Financeiro, Suporte, Comercial...). Cada uma tem horário próprio e a sua equipe.
 */

/** A fila está dentro do horário de atendimento agora (no fuso da plataforma)? */
function dentroHorario(fila, instante = new Date()) {
  if (!fila) return false;
  const l = local(instante);
  if (fila.dias[l.diaSemana] !== '1') return false;
  const minutos = l.hora * 60 + l.minuto;
  const [ah, am] = fila.abre.split(':').map(Number);
  const [fh, fm] = fila.fecha.split(':').map(Number);
  const abre = ah * 60 + am;
  const fecha = fh * 60 + fm;
  // Horário que atravessa a meia-noite (ex.: 18:00 às 02:00).
  return abre <= fecha ? minutos >= abre && minutos < fecha : minutos >= abre || minutos < fecha;
}

const listar = (db, empresaId, { todas = false } = {}) =>
  db.prepare(`SELECT * FROM filas WHERE empresa_id = ?${todas ? '' : ' AND ativa = 1'} ORDER BY ordem, nome`).all(empresaId);

const buscar = (db, empresaId, filaId) =>
  (filaId ? db.prepare('SELECT * FROM filas WHERE id = ? AND empresa_id = ?').get(Number(filaId), empresaId) : null);

/** Fila usada quando a IA transfere sem escolher uma: a configurada na IA ou a primeira ativa. */
function filaPadrao(db, empresaId) {
  const cfg = db.prepare('SELECT fila_padrao_id FROM ia_config WHERE empresa_id = ?').get(empresaId);
  return buscar(db, empresaId, cfg?.fila_padrao_id) ?? listar(db, empresaId)[0] ?? null;
}

/** Acha a fila pelo nome que a IA informou (ignora acentos e maiúsculas). */
function porNome(db, empresaId, nome) {
  const limpar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const alvo = limpar(nome);
  if (!alvo) return null;
  const filas = listar(db, empresaId);
  return filas.find((f) => limpar(f.nome) === alvo) ?? filas.find((f) => limpar(f.nome).includes(alvo) || alvo.includes(limpar(f.nome))) ?? null;
}

/** Atendentes da fila que estão disponíveis, com a carga atual, do menos ocupado para o mais ocupado. */
function candidatos(db, fila) {
  return db.prepare(`SELECT u.id, u.nome, u.max_simultaneas,
      (SELECT COUNT(*) FROM conversas c WHERE c.atendente_id = u.id AND c.estado = 'humano') AS carga
    FROM fila_usuarios fu
    JOIN usuarios u ON u.id = fu.usuario_id
    WHERE fu.fila_id = ? AND u.ativo = 1 AND u.disponivel = 1 AND u.perfil IN ('atendente','cliente')
    ORDER BY carga, u.id`).all(fila.id).filter((u) => u.carga < u.max_simultaneas);
}

/**
 * Entrega a conversa que está em 'aguardando' ao atendente mais livre da fila.
 * Sem ninguém disponível, a conversa continua na fila (o painel mostra a espera).
 */
function atribuir(db, conversa) {
  const fila = buscar(db, conversa.empresa_id, conversa.fila_id);
  if (!fila || conversa.estado !== 'aguardando') return null;
  const escolhido = candidatos(db, fila)[0];
  if (!escolhido) return null;
  db.prepare("UPDATE conversas SET estado = 'humano', atendente_id = ?, assumida_em = ? WHERE id = ? AND estado = 'aguardando'")
    .run(escolhido.id, agora(), conversa.id);
  return escolhido;
}

/** Quantas conversas estão esperando em cada fila e há quanto tempo a mais antiga espera. */
function espera(db, empresaId) {
  return db.prepare(`SELECT f.id, f.nome, COUNT(c.id) AS aguardando, MIN(c.transferida_em) AS mais_antiga
    FROM filas f LEFT JOIN conversas c ON c.fila_id = f.id AND c.estado = 'aguardando'
    WHERE f.empresa_id = ? AND f.ativa = 1 GROUP BY f.id ORDER BY f.ordem, f.nome`).all(empresaId)
    .map((f) => ({ ...f, espera_s: f.mais_antiga ? Math.round((Date.now() - Date.parse(f.mais_antiga)) / 1000) : 0 }));
}

/** Depois de assumir, devolver ou encerrar, tenta entregar as conversas que ficaram na fila. */
function girarFila(db, empresaId, filaId = null) {
  const pendentes = db.prepare(`SELECT * FROM conversas WHERE empresa_id = ? AND estado = 'aguardando'${filaId ? ' AND fila_id = ?' : ''}
    ORDER BY CASE prioridade WHEN 'alta' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, transferida_em`)
    .all(...(filaId ? [empresaId, filaId] : [empresaId]));
  const entregues = [];
  for (const c of pendentes) {
    const quem = atribuir(db, c);
    if (quem) entregues.push({ conversa_id: c.id, atendente_id: quem.id, atendente: quem.nome });
  }
  return entregues;
}

/** Confere que o usuário pode atender esta fila (ou é administrador da empresa). */
function exigirAcessoFila(db, usuario, fila) {
  if (usuario.perfil !== 'atendente') return;
  const ok = db.prepare('SELECT 1 FROM fila_usuarios WHERE fila_id = ? AND usuario_id = ?').get(fila.id, usuario.id);
  if (!ok) throw new ErroNegocio('Você não atende esta fila.', 403);
}

module.exports = { dentroHorario, listar, buscar, filaPadrao, porNome, candidatos, atribuir, espera, girarFila, exigirAcessoFila };
