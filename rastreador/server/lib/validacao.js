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

function cnpjValido(valor) {
  const cnpj = digitos(valor);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = pesos.reduce((acc, p, i) => acc + Number(base[i]) * p, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(cnpj.slice(0, 12));
  return cnpj.endsWith(`${d1}${calc(cnpj.slice(0, 12) + d1)}`);
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

/** Placa no padrão antigo (ABC1234) ou Mercosul (ABC1D23), guardada sem traço e em maiúsculas. */
function placa(v) {
  const p = String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
  exigir(/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p), 'Placa inválida (use ABC1234 ou ABC1D23).');
  return p;
}

/** IMEI de 15 dígitos com o dígito verificador (Luhn) certo. */
function imeiValido(t) {
  let soma = 0;
  [...t].reverse().forEach((d, i) => { let n = Number(d); if (i % 2) { n *= 2; if (n > 9) n -= 9; } soma += n; });
  return soma % 10 === 0;
}

/**
 * Identificador do equipamento: IMEI (15 dígitos, conferido pelo dígito verificador) ou o código do app
 * (4 a 40 letras, números, ponto, traço ou sublinhado).
 */
function imei(v) {
  const t = String(v ?? '').replace(/^IMEI[:\s]*/i, '').trim();
  exigir(/^[A-Za-z0-9._-]{4,40}$/.test(t), 'IMEI / identificador inválido (de 4 a 40 letras ou números).');
  if (/^\d{15}$/.test(t)) exigir(imeiValido(t), 'IMEI inválido: confira os 15 dígitos da etiqueta do rastreador.');
  return t;
}

/** Hora 'HH:MM' (00:00 a 23:59). */
function horario(v, nome) {
  const t = String(v ?? '').trim();
  exigir(/^([01]\d|2[0-3]):[0-5]\d$/.test(t), `${nome[0].toUpperCase()}${nome.slice(1)} inválido (use HH:MM).`);
  return t;
}

/** Latitude e longitude válidas (e não o 0,0 de equipamento sem sinal). */
function coordenadas(lat, lng) {
  const a = numero(lat, 'a latitude', { min: -90, max: 90 });
  const b = numero(lng, 'a longitude', { min: -180, max: 180 });
  exigir(!(a === 0 && b === 0), 'Posição inválida (0, 0).');
  return [a, b];
}

const booleano = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

module.exports = { digitos, cpfValido, cnpjValido, emailValido, dataValida, exigir, falhar, texto, opcional, inteiro, numero, opcao, email, senha, telefone, data, placa,
  imei, imeiValido, horario, coordenadas, booleano };
