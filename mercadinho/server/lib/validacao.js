'use strict';

const { ErroNegocio } = require('./erros');

const digitos = (v) => String(v ?? '').replace(/\D/g, '');

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

const emailValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? ''));

/** Data 'AAAA-MM-DD' que existe no calendário. */
function dataValida(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const falhar = (msg) => { throw new ErroNegocio(msg, 422); };
const exigir = (condicao, msg) => { if (!condicao) falhar(msg); };
const maiuscula = (t) => { const s = String(t ?? 'o valor'); return `${s[0].toUpperCase()}${s.slice(1)}`; };

/** Texto obrigatório, sem espaços nas pontas e com tamanho máximo. */
function texto(v, nome, max = 255) {
  const t = String(v ?? '').trim();
  exigir(t, `Informe ${nome}.`);
  exigir(t.length <= max, `${maiuscula(nome)} deve ter até ${max} caracteres.`);
  return t;
}
const opcional = (v, nome, max = 255) => (v === undefined || v === null || String(v).trim() === '' ? null : texto(v, nome, max));

function inteiro(v, nome, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(v);
  exigir(Number.isInteger(n) && n >= min && n <= max, `${maiuscula(nome)} inválido.`);
  return n;
}

function numero(v, nome, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  exigir(v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n >= min && n <= max, `${maiuscula(nome)} inválido.`);
  return n;
}

const opcao = (v, nome, opcoes) => {
  exigir(opcoes.includes(v), `${maiuscula(nome)} inválido.`);
  return v;
};

const email = (v) => {
  const e = texto(v, 'o e-mail', 160).toLowerCase();
  exigir(emailValido(e), 'E-mail inválido.');
  return e;
};
const emailOpcional = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : email(v));

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
const telefoneOpcional = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : telefone(v));

const data = (v, nome) => {
  exigir(dataValida(v), `${maiuscula(nome)} inválida (use AAAA-MM-DD).`);
  return v;
};
const dataOpcional = (v, nome) => (v === undefined || v === null || String(v).trim() === '' ? null : data(v, nome));

const competencia = (v, nome = 'a competência') => {
  exigir(/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v ?? '')), `${maiuscula(nome)} inválida (use AAAA-MM).`);
  return v;
};

/** Valor em reais (número ou texto com vírgula) convertido para centavos. */
function centavos(v, nome, { min = 0, max = 100_000_000 } = {}) {
  const n = numero(v, nome, { min, max });
  return Math.round(n * 100);
}
const centavosOpcional = (v, nome, o) => (v === undefined || v === null || String(v).trim() === '' ? null : centavos(v, nome, o));

/**
 * Quantidade em milésimos (três casas decimais): 1 unidade = 1000, 350 g = 350.
 * Assim produtos vendidos por peso e por unidade usam a mesma conta, sem erro de ponto flutuante.
 */
function quantidade(v, nome = 'a quantidade', { min = 1, max = 100_000_000 } = {}) {
  const n = numero(v, nome, { min: -Infinity, max: Infinity });
  const mil = Math.round(n * 1000);
  exigir(mil >= min && mil <= max, `${maiuscula(nome)} inválida.`);
  return mil;
}

/**
 * Código de barras EAN-8/EAN-13/DUN-14 ou código interno (só dígitos, 4 a 14).
 * Códigos EAN têm o dígito verificador conferido; códigos internos ficam como estão.
 */
function codigoBarras(v) {
  const c = digitos(v);
  exigir(c.length >= 4 && c.length <= 14, 'Código de barras inválido (de 4 a 14 dígitos).');
  if ([8, 12, 13, 14].includes(c.length)) exigir(digitoEanValido(c), 'Código de barras com dígito verificador incorreto.');
  return c;
}

function digitoEanValido(codigo) {
  const corpo = codigo.slice(0, -1).split('').reverse();
  const soma = corpo.reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === Number(codigo.at(-1));
}

module.exports = {
  digitos, cnpjValido, cpfValido, emailValido, dataValida, digitoEanValido, exigir, falhar,
  texto, opcional, inteiro, numero, opcao, email, emailOpcional, senha, telefone, telefoneOpcional,
  data, dataOpcional, competencia, centavos, centavosOpcional, quantidade, codigoBarras,
};
