'use strict';

/*
 * Teclado virtual de pares (ex.: "1 ou 4", "3 ou 6"). O servidor sorteia os pares a cada uso e
 * recebe apenas os botões clicados. Quem observar a tela ou capturar o tráfego não descobre os dígitos.
 */
const crypto = require('node:crypto');
const { ErroNegocio } = require('./erros');

const TAMANHO_SENHA = 6;

function embaralhar(lista) {
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function criarDesafio(db) {
  db.prepare("DELETE FROM desafios_teclado WHERE expira_em < datetime('now') OR usado = 1").run();
  const d = embaralhar([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const teclas = [0, 2, 4, 6, 8].map((i) => [d[i], d[i + 1]].sort((x, y) => x - y));
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO desafios_teclado (id, teclas, expira_em) VALUES (?, ?, datetime('now', '+3 minutes'))").run(id, JSON.stringify(teclas));
  return { id, teclas };
}

/**
 * Consome o desafio (uso único) e devolve todas as senhas possíveis para a sequência de botões.
 * Com 6 posições e 2 dígitos por botão, são 64 candidatos.
 */
function candidatos(db, entrada) {
  const id = String(entrada?.teclado_id ?? '');
  const sequencia = entrada?.sequencia;
  const linha = db.prepare("SELECT * FROM desafios_teclado WHERE id = ? AND usado = 0 AND expira_em >= datetime('now')").get(id);
  if (!linha) throw new ErroNegocio('O teclado expirou. Digite a senha novamente.', 422);
  db.prepare('UPDATE desafios_teclado SET usado = 1 WHERE id = ?').run(id);
  if (!Array.isArray(sequencia) || sequencia.length !== TAMANHO_SENHA || !sequencia.every((i) => Number.isInteger(i) && i >= 0 && i < 5)) {
    throw new ErroNegocio(`Digite os ${TAMANHO_SENHA} dígitos da senha.`, 422);
  }
  const teclas = JSON.parse(linha.teclas);
  return sequencia.reduce((parciais, i) => parciais.flatMap((p) => teclas[i].map((d) => p + d)), ['']);
}

/** Regras para senhas numéricas novas (acesso e transação). */
function senhaNumericaValida(s) {
  if (!/^\d{6}$/.test(String(s ?? ''))) return false;
  if (/^(\d)\1{5}$/.test(s)) return false;
  const passos = [...s].slice(1).map((c, i) => Number(c) - Number(s[i]));
  return !passos.every((p) => p === 1) && !passos.every((p) => p === -1);
}

module.exports = { criarDesafio, candidatos, senhaNumericaValida, TAMANHO_SENHA };
