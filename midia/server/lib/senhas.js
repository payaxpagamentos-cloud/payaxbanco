'use strict';

const { agora } = require('../db');
const { hoje } = require('./datas');
const { ErroNegocio } = require('./erros');

/**
 * Controle de senha (fila de atendimento) do ponto.
 *
 * O atendente aperta "chamar próxima" no celular ou no computador e a senha aparece na metade de cima
 * da TV, com o guichê. As senhas são numeradas por tipo — N (normal) e P (preferencial) — e recomeçam
 * do 1 a cada dia. Quem entrega a senha ao cliente é a loja (bloco numerado, por exemplo): aqui fica só
 * a chamada, que é o que precisa aparecer na tela.
 */
const TIPOS = { N: 'Normal', P: 'Preferencial' };
const codigo = (s) => `${s.tipo}${String(s.numero).padStart(3, '0')}`;

const limpar = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

/** Situação do dia: a senha no painel, as últimas chamadas e qual será a próxima de cada tipo. */
function situacao(db, localId) {
  const data = hoje();
  const chamadas = db.prepare('SELECT * FROM senhas WHERE local_id = ? AND data = ? ORDER BY COALESCE(repetida_em, chamada_em) DESC, id DESC LIMIT 6')
    .all(localId, data).map((s) => ({ id: s.id, codigo: codigo(s), tipo: s.tipo, numero: s.numero, guiche: s.guiche, chamada_em: s.chamada_em, repetida_em: s.repetida_em }));
  const maior = (tipo) => db.prepare('SELECT COALESCE(MAX(numero), 0) AS n FROM senhas WHERE local_id = ? AND data = ? AND tipo = ?').get(localId, data, tipo).n;
  return {
    atual: chamadas[0] ?? null,
    ultimas: chamadas.slice(1, 5),
    proxima: { N: `N${String(maior('N') + 1).padStart(3, '0')}`, P: `P${String(maior('P') + 1).padStart(3, '0')}` },
    chamadas_hoje: db.prepare('SELECT COUNT(*) AS n FROM senhas WHERE local_id = ? AND data = ?').get(localId, data).n,
  };
}

/** Chama a próxima senha do tipo (ou um número específico, para voltar numa que ficou para trás). */
function chamar(db, localId, { tipo = 'N', guiche, numero } = {}, usuarioId = null) {
  const t = String(tipo).toUpperCase();
  if (!TIPOS[t]) throw new ErroNegocio('Tipo de senha inválido.', 422);
  const onde = limpar(guiche, 30) || 'Guichê 1';
  const data = hoje();
  let n;
  if (numero !== undefined && numero !== null && numero !== '') {
    n = Number(numero);
    if (!Number.isInteger(n) || n < 1 || n > 999) throw new ErroNegocio('Informe um número de senha entre 1 e 999.', 422);
  } else {
    n = db.prepare('SELECT COALESCE(MAX(numero), 0) AS n FROM senhas WHERE local_id = ? AND data = ? AND tipo = ?').get(localId, data, t).n + 1;
    if (n > 999) throw new ErroNegocio('As senhas de hoje chegaram a 999. Zere a contagem para continuar.', 409);
  }
  db.prepare('INSERT INTO senhas (local_id, data, tipo, numero, guiche, chamada_em, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(localId, data, t, n, onde, agora(), usuarioId);
  return situacao(db, localId);
}

/** Chama de novo a senha que está no painel (o cliente não ouviu). */
function repetir(db, localId) {
  const s = situacao(db, localId);
  if (!s.atual) throw new ErroNegocio('Ainda não há senha chamada hoje.', 409);
  db.prepare('UPDATE senhas SET repetida_em = ? WHERE id = ?').run(agora(), s.atual.id);
  return situacao(db, localId);
}

/** Recomeça a contagem do dia (apaga as chamadas de hoje deste ponto). */
function zerar(db, localId) {
  db.prepare('DELETE FROM senhas WHERE local_id = ? AND data = ?').run(localId, hoje());
  return situacao(db, localId);
}

module.exports = { TIPOS, situacao, chamar, repetir, zerar };
