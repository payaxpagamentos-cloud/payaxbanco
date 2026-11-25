'use strict';

const { agora } = require('../db');
const { hoje } = require('./datas');
const { ErroNegocio } = require('./erros');

/**
 * Controle de senha (fila de atendimento) do ponto.
 *
 * O atendente aperta "chamar próxima" no celular ou no computador e a senha aparece na TV, com o guichê.
 * As senhas são numeradas por tipo — N (normal) e P (preferencial) — e recomeçam do 0001 a cada dia.
 * Quem entrega a senha ao cliente é a loja (bloco numerado, por exemplo): aqui fica a chamada e o
 * atendimento — o assunto e quanto tempo durou (da chamada até encerrar ou chamar a próxima).
 */
const TIPOS = { N: 'Normal', P: 'Preferencial' };
const MAXIMO = 9999;
const formatar = (tipo, numero) => `${tipo}${String(numero).padStart(4, '0')}`;
const codigo = (s) => formatar(s.tipo, s.numero);

const limpar = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const segundos = (de, ate) => Math.max(0, Math.round((Date.parse(ate) - Date.parse(de)) / 1000));

const publica = (s) => ({
  id: s.id, codigo: codigo(s), tipo: s.tipo, numero: s.numero, guiche: s.guiche, chamada_em: s.chamada_em, repetida_em: s.repetida_em,
  assunto: s.assunto ?? null, encerrada_em: s.encerrada_em ?? null,
  // Tempo de atendimento: só existe depois de encerrado.
  duracao_s: s.encerrada_em ? segundos(s.chamada_em, s.encerrada_em) : null,
});

/** Situação do dia: a senha na TV, as últimas chamadas, a próxima de cada tipo e os atendimentos. */
function situacao(db, localId, guiche = null) {
  const data = hoje();
  const doDia = db.prepare('SELECT * FROM senhas WHERE local_id = ? AND data = ?').all(localId, data);
  const porChamada = [...doDia].sort((a, b) => (b.repetida_em ?? b.chamada_em).localeCompare(a.repetida_em ?? a.chamada_em) || b.id - a.id);
  const maior = (tipo) => doDia.filter((s) => s.tipo === tipo).reduce((m, s) => Math.max(m, s.numero), 0);
  const encerradas = doDia.filter((s) => s.encerrada_em);
  const onde = limpar(guiche, 30);
  // A senha que este guichê está atendendo agora (chamada e ainda não encerrada).
  const aberta = onde ? doDia.filter((s) => s.guiche === onde && !s.encerrada_em).sort((a, b) => b.id - a.id)[0] : null;
  return {
    atual: porChamada[0] ? publica(porChamada[0]) : null,
    ultimas: porChamada.slice(1, 5).map(publica),
    proxima: { N: formatar('N', maior('N') + 1), P: formatar('P', maior('P') + 1) },
    chamadas_hoje: doDia.length,
    em_atendimento: aberta ? publica(aberta) : null,
    atendimentos: [...doDia].sort((a, b) => b.id - a.id).slice(0, 60).map(publica),
    encerrados_hoje: encerradas.length,
    tempo_medio_s: encerradas.length ? Math.round(encerradas.reduce((t, s) => t + segundos(s.chamada_em, s.encerrada_em), 0) / encerradas.length) : null,
    // Sugestões de assunto: os mais usados neste ponto.
    assuntos: db.prepare(`SELECT assunto FROM senhas WHERE local_id = ? AND assunto IS NOT NULL AND assunto <> ''
      GROUP BY assunto ORDER BY COUNT(*) DESC, MAX(id) DESC LIMIT 12`).all(localId).map((a) => a.assunto),
  };
}

/** Fecha o atendimento em aberto do guichê (com o assunto, se veio). */
function fecharAberta(db, localId, guiche, assunto) {
  const texto = limpar(assunto, 80) || null;
  db.prepare(`UPDATE senhas SET encerrada_em = ?, assunto = COALESCE(?, assunto)
    WHERE local_id = ? AND data = ? AND guiche = ? AND encerrada_em IS NULL`).run(agora(), texto, localId, hoje(), guiche);
}

/**
 * Chama a próxima senha do tipo (ou um número específico, para voltar numa que ficou para trás).
 * Chamar a próxima encerra o atendimento que este guichê tinha em aberto: é aí que o tempo dele fecha.
 */
function chamar(db, localId, { tipo = 'N', guiche, numero, assunto_anterior } = {}, usuarioId = null) {
  const t = String(tipo).toUpperCase();
  if (!TIPOS[t]) throw new ErroNegocio('Tipo de senha inválido.', 422);
  const onde = limpar(guiche, 30) || 'Guichê 1';
  const data = hoje();
  let n;
  if (numero !== undefined && numero !== null && numero !== '') {
    n = Number(numero);
    if (!Number.isInteger(n) || n < 1 || n > MAXIMO) throw new ErroNegocio(`Informe um número de senha entre 1 e ${MAXIMO}.`, 422);
  } else {
    n = db.prepare('SELECT COALESCE(MAX(numero), 0) AS n FROM senhas WHERE local_id = ? AND data = ? AND tipo = ?').get(localId, data, t).n + 1;
    if (n > MAXIMO) throw new ErroNegocio(`As senhas de hoje chegaram a ${MAXIMO}. Zere a contagem para continuar.`, 409);
  }
  fecharAberta(db, localId, onde, assunto_anterior);
  db.prepare('INSERT INTO senhas (local_id, data, tipo, numero, guiche, chamada_em, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(localId, data, t, n, onde, agora(), usuarioId);
  return situacao(db, localId, onde);
}

/** Encerra o atendimento em aberto do guichê, sem chamar outra senha (fim do expediente, pausa). */
function encerrar(db, localId, { guiche, assunto } = {}) {
  const onde = limpar(guiche, 30) || 'Guichê 1';
  if (!situacao(db, localId, onde).em_atendimento) throw new ErroNegocio('Este guichê não tem atendimento em aberto.', 409);
  fecharAberta(db, localId, onde, assunto);
  return situacao(db, localId, onde);
}

/** Corrige ou preenche o assunto de um atendimento (esqueceu de escrever na hora). */
function definirAssunto(db, localId, id, assunto, guiche = null) {
  const s = db.prepare('SELECT id FROM senhas WHERE id = ? AND local_id = ?').get(Number(id), localId);
  if (!s) throw new ErroNegocio('Senha não encontrada neste ponto.', 404);
  db.prepare('UPDATE senhas SET assunto = ? WHERE id = ?').run(limpar(assunto, 80) || null, s.id);
  return situacao(db, localId, guiche);
}

/** Chama de novo a senha que está na TV (o cliente não ouviu). Não mexe no tempo do atendimento. */
function repetir(db, localId, guiche = null) {
  const s = situacao(db, localId);
  if (!s.atual) throw new ErroNegocio('Ainda não há senha chamada hoje.', 409);
  db.prepare('UPDATE senhas SET repetida_em = ? WHERE id = ?').run(agora(), s.atual.id);
  return situacao(db, localId, guiche);
}

/** Recomeça a contagem do dia (apaga as chamadas de hoje deste ponto). */
function zerar(db, localId, guiche = null) {
  db.prepare('DELETE FROM senhas WHERE local_id = ? AND data = ?').run(localId, hoje());
  return situacao(db, localId, guiche);
}

module.exports = { TIPOS, situacao, chamar, encerrar, definirAssunto, repetir, zerar };
