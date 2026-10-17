'use strict';

const { ErroNegocio } = require('./erros');

const digitos = (v) => String(v ?? '').replace(/\D/g, '');

function cpfValido(valor) {
  const cpf = digitos(valor);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(cpf[t])) return false;
  }
  return true;
}

/** CNH: 11 dígitos com os dois verificadores (cálculo do Denatran). */
function cnhValida(valor) {
  const cnh = digitos(valor);
  if (cnh.length !== 11 || /^(\d)\1{10}$/.test(cnh)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += Number(cnh[i]) * (9 - i);
  let d1 = soma % 11;
  let desconto = 0;
  if (d1 >= 10) { d1 = 0; desconto = 2; }
  soma = 0;
  for (let i = 0; i < 9; i++) soma += Number(cnh[i]) * (i + 1);
  const resto = soma % 11;
  // Quando o desconto deixa o dígito negativo, ele volta ao intervalo 0–9 (assim nenhuma CNH emitida é recusada).
  let d2 = resto >= 10 ? 0 : resto - desconto;
  if (d2 < 0) d2 += 11;
  if (d2 >= 10) d2 = 0;
  return `${d1}${d2}` === cnh.slice(9);
}

const emailValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? ''));

/** Data 'AAAA-MM-DD' que existe no calendário. */
function dataValida(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const falhar = (msg) => { throw new ErroNegocio(msg, 422); };
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
  exigir(Number.isInteger(n) && n >= min && n <= max, `${nome[0].toUpperCase()}${nome.slice(1)} inválido.`);
  return n;
}

function numero(v, nome, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  exigir(v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n >= min && n <= max, `${nome[0].toUpperCase()}${nome.slice(1)} inválido.`);
  return n;
}

const opcao = (v, nome, opcoes) => {
  exigir(opcoes.includes(v), `${nome[0].toUpperCase()}${nome.slice(1)} inválido.`);
  return v;
};

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
  exigir(dataValida(v), `${nome[0].toUpperCase()}${nome.slice(1)} inválida (use AAAA-MM-DD).`);
  return v;
};

/** Ponto { endereco, lat, lng }. */
function ponto(p, nome) {
  exigir(p && typeof p === 'object', `Informe ${nome}.`);
  return {
    endereco: texto(p.endereco, `o endereço de ${nome}`, 300),
    lat: numero(p.lat, `a latitude de ${nome}`, { min: -90, max: 90 }),
    lng: numero(p.lng, `a longitude de ${nome}`, { min: -180, max: 180 }),
  };
}

/** Placa antiga (ABC1234) ou Mercosul (ABC1D23), guardada sem hífen e em maiúsculas. */
function placa(v) {
  const p = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  exigir(/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p), 'Placa inválida (ex.: ABC1D23 ou ABC1234).');
  return p;
}

module.exports = { digitos, cpfValido, cnhValida, emailValido, dataValida, exigir, falhar, texto, opcional, inteiro, numero, opcao, email, senha, telefone, data, ponto, placa };
