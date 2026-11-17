'use strict';

const config = require('../config');
const { agora, lerConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { assinar, confere } = require('./cripto');
const v = require('./validacao');

/**
 * Token de reprodução: liga uma tela (sessão) a um conteúdo e vale por algumas horas.
 * Vai na URL do player (o <video> e o hls.js não enviam cabeçalho de autorização),
 * por isso é assinado, tem validade curta e não serve para mais nada na API.
 */
function emitirToken(dados) {
  const payload = Buffer.from(JSON.stringify({ ...dados, exp: Math.floor(Date.now() / 1000) + config.playTokenSegundos })).toString('base64url');
  return `${payload}.${assinar(`play:${payload}`)}`;
}

function lerToken(token) {
  const [payload, assinatura] = String(token ?? '').split('.');
  if (!payload || !assinatura || !confere(assinar(`play:${payload}`), assinatura)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.exp > Date.now() / 1000 ? d : null;
  } catch {
    return null;
  }
}

const TIPOS = ['canal', 'filme', 'episodio', 'trailer'];

/** Telas que ainda dão sinal de vida (o plano limita quantas podem assistir ao mesmo tempo). */
function sessoesVivas(db, usuarioId) {
  const corte = new Date(Date.now() - config.sessaoPlayerSegundos * 1000).toISOString();
  return db.prepare(`SELECT s.*, c.nome AS canal_nome, t.nome AS titulo_nome, e.nome AS episodio_nome
    FROM sessoes_player s LEFT JOIN canais c ON c.id = s.canal_id LEFT JOIN titulos t ON t.id = s.titulo_id LEFT JOIN episodios e ON e.id = s.episodio_id
    WHERE s.usuario_id = ? AND s.encerrada_em IS NULL AND s.ultimo_ping >= ? ORDER BY s.iniciada_em`).all(Number(usuarioId), corte);
}

/** Fecha as telas que pararam de dar sinal de vida (fechou o navegador, acabou a internet). */
function encerrarSessoesMortas(db) {
  const corte = new Date(Date.now() - config.sessaoPlayerSegundos * 1000).toISOString();
  return db.prepare("UPDATE sessoes_player SET encerrada_em = ?, motivo_fim = 'sem_sinal' WHERE encerrada_em IS NULL AND ultimo_ping < ?")
    .run(agora(), corte).changes;
}

/** Encerra as outras telas da conta (o assinante escolhe isso quando bate no limite do plano). */
function encerrarOutras(db, usuarioId, manterId = null) {
  return db.prepare("UPDATE sessoes_player SET encerrada_em = ?, motivo_fim = 'outra_tela' WHERE usuario_id = ? AND encerrada_em IS NULL AND id <> ?")
    .run(agora(), Number(usuarioId), Number(manterId) || -1).changes;
}

/**
 * Abre uma tela: confere o limite do plano e registra a sessão.
 * Devolve a sessão e o token de reprodução que o player usa nas URLs.
 */
function abrirSessao(db, { usuario, perfil, acesso, tipo, canal = null, titulo = null, episodio = null, midiaId = null, dispositivo, ip, qualidade }) {
  v.opcao(tipo, 'o tipo de reprodução', TIPOS);
  encerrarSessoesMortas(db);
  const vivas = sessoesVivas(db, usuario.id);
  if (vivas.length >= acesso.telas) {
    throw new ErroNegocio(acesso.telas === 1
      ? 'Seu plano permite uma tela por vez. Pare a outra tela ou mude de plano.'
      : `Seu plano permite ${acesso.telas} telas ao mesmo tempo e todas estão em uso.`, 409,
    { telas: acesso.telas, em_uso: vivas.map((s) => ({ id: s.id, o_que: s.canal_nome ?? s.episodio_nome ?? s.titulo_nome, dispositivo: s.dispositivo, desde: s.iniciada_em })) });
  }
  const r = db.prepare(`INSERT INTO sessoes_player (usuario_id, perfil_id, tipo, canal_id, titulo_id, episodio_id, dispositivo, ip, qualidade, iniciada_em, ultimo_ping)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(usuario.id, perfil.id, tipo, canal?.id ?? null, titulo?.id ?? null, episodio?.id ?? null,
    v.opcional(dispositivo, 'o aparelho', 120), ip ?? null, qualidade ?? acesso.qualidade, agora(), agora());
  const sessao = db.prepare('SELECT * FROM sessoes_player WHERE id = ?').get(Number(r.lastInsertRowid));
  const token = emitirToken({
    s: sessao.id, u: usuario.id, p: perfil.id, t: tipo,
    c: canal?.id ?? null, i: titulo?.id ?? null, e: episodio?.id ?? null, m: midiaId ?? null,
  });
  return { sessao, token };
}

/** A sessão continua valendo? (usado nas listas HLS e ao retomar o vídeo) */
function sessaoViva(db, sessaoId) {
  const corte = new Date(Date.now() - config.sessaoPlayerSegundos * 1000).toISOString();
  return db.prepare('SELECT * FROM sessoes_player WHERE id = ? AND encerrada_em IS NULL AND ultimo_ping >= ?').get(Number(sessaoId), corte);
}

/**
 * Confere o token que veio na URL do player. `exigirSessaoViva` fica ligado nas chamadas
 * espaçadas (lista HLS, começo do vídeo) e desligado nos segmentos, que são muitos.
 */
function conferirToken(db, token, { tipo = null, canalId = null, midiaId = null, exigirSessaoViva = true } = {}) {
  const d = lerToken(token);
  if (!d) throw new ErroNegocio('Link de reprodução expirado. Abra o conteúdo de novo.', 401);
  if (tipo && d.t !== tipo) throw new ErroNegocio('Link de reprodução inválido para este conteúdo.', 403);
  if (canalId && Number(d.c) !== Number(canalId)) throw new ErroNegocio('Link de reprodução inválido para este canal.', 403);
  if (midiaId && Number(d.m) !== Number(midiaId)) throw new ErroNegocio('Link de reprodução inválido para este arquivo.', 403);
  if (exigirSessaoViva && !sessaoViva(db, d.s)) throw new ErroNegocio('Esta tela foi encerrada. Abra o conteúdo de novo.', 409);
  return d;
}

/** Guarda onde o assinante parou (continuar assistindo). */
function registrarProgresso(db, perfilId, { titulo_id: tituloId, episodio_id: episodioId = 0, segundos, duracao_s: duracao }) {
  const t = v.inteiro(tituloId, 'o título', { min: 1 });
  const e = Number(episodioId) || 0;
  const seg = v.inteiro(Math.round(segundos), 'a posição', { min: 0, max: 86_400 });
  const dur = v.inteiro(Math.round(duracao || 0), 'a duração', { min: 0, max: 86_400 });
  const { creditos_s: creditos } = lerConfig(db);
  const concluido = dur > 0 && seg >= Math.max(0, dur - creditos) ? 1 : 0;
  db.prepare(`INSERT INTO progresso (perfil_id, titulo_id, episodio_id, segundos, duracao_s, concluido, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (perfil_id, titulo_id, episodio_id) DO UPDATE SET
      segundos = excluded.segundos, duracao_s = MAX(excluded.duracao_s, progresso.duracao_s),
      concluido = excluded.concluido, atualizado_em = excluded.atualizado_em`)
    .run(Number(perfilId), t, e, seg, dur, concluido, agora());
  return { segundos: seg, concluido: Boolean(concluido) };
}

/** Onde retomar: um pouco antes de onde parou; do começo quando já terminou. */
function retomarEm(db, perfilId, tituloId, episodioId = 0) {
  const p = db.prepare('SELECT * FROM progresso WHERE perfil_id = ? AND titulo_id = ? AND episodio_id = ?')
    .get(Number(perfilId), Number(tituloId), Number(episodioId) || 0);
  if (!p || p.concluido) return 0;
  const { retomar_folga_s: folga } = lerConfig(db);
  return Math.max(0, p.segundos - folga);
}

/** Sinal de vida da tela: mantém a vaga do plano e soma a audiência. */
function ping(db, usuarioId, sessaoId, { segundos = null, posicao = null, duracao = null } = {}) {
  const s = db.prepare('SELECT * FROM sessoes_player WHERE id = ? AND usuario_id = ?').get(Number(sessaoId), Number(usuarioId));
  if (!s) throw naoEncontrado('Tela');
  if (s.encerrada_em) throw new ErroNegocio('Esta tela foi encerrada. Abra o conteúdo de novo.', 409, { encerrada: true });
  const assistidos = segundos === null ? s.segundos : v.inteiro(Math.round(segundos), 'o tempo assistido', { min: 0, max: 86_400 * 2 });
  db.prepare('UPDATE sessoes_player SET ultimo_ping = ?, segundos = ? WHERE id = ?').run(agora(), Math.max(s.segundos, assistidos), s.id);
  if (posicao !== null && s.titulo_id) {
    registrarProgresso(db, s.perfil_id, { titulo_id: s.titulo_id, episodio_id: s.episodio_id ?? 0, segundos: posicao, duracao_s: duracao ?? 0 });
  }
  return { ok: true };
}

function fechar(db, usuarioId, sessaoId, motivo = 'fim') {
  const n = db.prepare("UPDATE sessoes_player SET encerrada_em = ?, motivo_fim = ? WHERE id = ? AND usuario_id = ? AND encerrada_em IS NULL")
    .run(agora(), String(motivo).slice(0, 40), Number(sessaoId), Number(usuarioId)).changes;
  return { encerrada: n > 0 };
}

module.exports = {
  TIPOS, emitirToken, lerToken, conferirToken, abrirSessao, sessaoViva, sessoesVivas, encerrarSessoesMortas, encerrarOutras,
  registrarProgresso, retomarEm, ping, fechar,
};
