'use strict';

const { ErroNegocio } = require('./erros');

const digitos = (v) => String(v ?? '').replace(/\D/g, '');
const emailValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? ''));

/** Data 'AAAA-MM-DD' que existe no calendário. */
function dataValida(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const falhar = (msg) => { throw new ErroNegocio(msg, 422); };

/** "o ano" -> "Ano inválido"; "a duração" -> "Duração inválida" (concorda com o artigo do nome do campo). */
const invalido = (nome) => {
  const feminino = /^(a|as|uma) /i.test(String(nome));
  const limpo = String(nome).replace(/^(o|a|os|as|um|uma) /i, '');
  return `${limpo[0].toUpperCase()}${limpo.slice(1)} ${feminino ? 'inválida' : 'inválido'}.`;
};
const exigir = (condicao, msg) => { if (!condicao) falhar(msg); };

/** Texto obrigatório, sem espaços nas pontas e com tamanho máximo. */
function texto(v, nome, max = 255) {
  const t = String(v ?? '').trim();
  exigir(t, `Informe ${nome}.`);
  exigir(t.length <= max, `${nome[0].toUpperCase()}${nome.slice(1)} deve ter até ${max} caracteres.`);
  return t;
}
const opcional = (v, nome, max = 255) => (v === undefined || v === null || String(v).trim() === '' ? null : texto(v, nome, max));

function inteiro(v, nome, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(v);
  exigir(Number.isInteger(n) && n >= min && n <= max, invalido(nome));
  return n;
}
const inteiroOpcional = (v, nome, o) => (v === undefined || v === null || v === '' ? null : inteiro(v, nome, o));

function numero(v, nome, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  exigir(v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n >= min && n <= max, invalido(nome));
  return n;
}

/** Identificador de registro (inteiro positivo); null quando ausente. */
const id = (v, nome = 'o registro') => (v === undefined || v === null || v === '' ? null : inteiro(v, nome, { min: 1 }));

const opcao = (v, nome, opcoes) => {
  exigir(opcoes.includes(v), `${invalido(nome).replace(/\.$/, '')}. Use: ${opcoes.join(', ')}.`);
  return v;
};

const booleano = (v, padrao = false) => (v === undefined || v === null || v === '' ? padrao : v === true || v === 1 || v === '1' || v === 'true');

const email = (v) => {
  const e = texto(v, 'o e-mail', 160).toLowerCase();
  exigir(emailValido(e), 'E-mail inválido.');
  return e;
};

const senha = (v) => {
  exigir(typeof v === 'string' && v.length >= 8, 'A senha deve ter pelo menos 8 caracteres.');
  exigir(v.length <= 200, 'Senha longa demais.');
  return v;
};

const telefone = (v) => {
  const t = digitos(v);
  exigir(t.length >= 10 && t.length <= 13, 'Telefone inválido (informe DDD e número).');
  return t;
};

const data = (v, nome) => {
  exigir(dataValida(v), `${invalido(nome).replace(/\.$/, '')} (use AAAA-MM-DD).`);
  return v;
};

/** Instante ISO 8601 (ex.: 2026-03-01T22:30:00Z), guardado normalizado em UTC. */
function instante(v, nome) {
  const t = Date.parse(String(v ?? ''));
  exigir(Number.isFinite(t), `${invalido(nome).replace(/\.$/, '')} (use data e hora ISO 8601).`);
  return new Date(t).toISOString();
}

/** Classificação indicativa: 0 (Livre), 10, 12, 14, 16 ou 18. */
const classificacao = (v, padrao = 0) => (v === undefined || v === null || v === '' ? padrao : opcao(Number(v), 'a classificação indicativa', [0, 10, 12, 14, 16, 18]));

/**
 * Endereço do sinal do canal: só http(s) e sem credenciais na URL. A retransmissão recusa
 * endereços de rede interna (ver lib/relay.js), por isso aqui a conferência é de formato.
 */
function urlHls(v, { obrigatorio = true } = {}) {
  if (!obrigatorio && (v === undefined || v === null || String(v).trim() === '')) return null;
  const t = texto(v, 'o endereço do sinal (.m3u8)', 1000);
  let u;
  try { u = new URL(t); } catch { falhar('Endereço do sinal inválido (use http:// ou https://).'); }
  exigir(['http:', 'https:'].includes(u.protocol), 'Endereço do sinal inválido (use http:// ou https://).');
  exigir(!u.username && !u.password, 'Não coloque usuário e senha no endereço: use um endereço assinado pela emissora.');
  return u.toString();
}

/** Idioma no formato pt-BR, en, es-419. */
const idioma = (v, padrao = 'pt-BR') => {
  if (v === undefined || v === null || v === '') return padrao;
  const t = String(v).trim();
  exigir(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(t), 'Idioma inválido (ex.: pt-BR, en, es).');
  return t;
};

module.exports = {
  digitos, emailValido, dataValida, exigir, falhar, invalido, texto, opcional, inteiro, inteiroOpcional, numero, id, opcao, booleano,
  email, senha, telefone, data, instante, classificacao, urlHls, idioma,
};
