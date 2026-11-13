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

/** Hora 'HH:MM' (00:00 a 23:59). */
function horario(v, nome) {
  const t = String(v ?? '').trim();
  exigir(/^([01]\d|2[0-3]):[0-5]\d$/.test(t), `${nome[0].toUpperCase()}${nome.slice(1)} inválido (use HH:MM).`);
  return t;
}

const booleano = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

/** Instante ISO 8601 válido, devolvido em UTC. */
function instante(v, nome) {
  const t = Date.parse(String(v ?? ''));
  exigir(typeof v === 'string' && Number.isFinite(t), `${nome[0].toUpperCase()}${nome.slice(1)} inválido (use data e hora ISO 8601).`);
  return new Date(t).toISOString();
}
const instanteOpcional = (v, nome) => (v === undefined || v === null || v === '' ? null : instante(v, nome));
const dataOpcional = (v, nome) => (v === undefined || v === null || v === '' ? null : data(v, nome));
const inteiroOpcional = (v, nome, lim) => (v === undefined || v === null || v === '' ? null : inteiro(v, nome, lim));

/**
 * Valor em reais (número ou texto "1.234,56" / "1234.56") para centavos inteiros, sem passar por ponto flutuante na conversão final.
 */
function centavos(v, nome, { min = 0 } = {}) {
  if (Number.isInteger(v)) { exigir(v >= min * 100, `${nome[0].toUpperCase()}${nome.slice(1)} inválido.`); return v * 100; }
  let t = String(v ?? '').trim().replace(/^R\$\s*/, '');
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  exigir(m, `${nome[0].toUpperCase()}${nome.slice(1)} inválido.`);
  const c = (Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))) * (m[1] ? -1 : 1);
  exigir(Number.isSafeInteger(c) && c >= min * 100, `${nome[0].toUpperCase()}${nome.slice(1)} inválido.`);
  return c;
}
const centavosOpcional = (v, nome) => (v === undefined || v === null || v === '' ? null : centavos(v, nome));

/** Número decimal com até `casas` casas, convertido para inteiro na escala 10^casas (ex.: litros → mL com casas = 3). */
function escalado(v, nome, casas, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  let t = String(v ?? '').trim();
  if (/,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${casas}}))?$`).exec(t);
  exigir(m, `${nome[0].toUpperCase()}${nome.slice(1)} inválido (até ${casas} casas decimais).`);
  const n = Number(m[1]) * 10 ** casas + Number((m[2] ?? '').padEnd(casas, '0'));
  exigir(Number.isSafeInteger(n) && n >= min && n <= max, `${nome[0].toUpperCase()}${nome.slice(1)} fora do limite.`);
  return n;
}

/** CPF ou CNPJ válido, guardado só com os dígitos. */
function documento(v, nome = 'o CPF/CNPJ') {
  const d = digitos(v);
  exigir(d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false, `${nome[0].toUpperCase()}${nome.slice(1)} é inválido.`);
  return d;
}
const documentoOpcional = (v, nome) => (v === undefined || v === null || String(v).trim() === '' ? null : documento(v, nome));

function cnpj(v) {
  const d = digitos(v);
  exigir(cnpjValido(d), 'CNPJ inválido.');
  return d;
}

/**
 * Chave PIX: CPF/CNPJ (só dígitos), celular em +55DDDNNNNNNNNN, e-mail, chave aleatória (UUID) ou o próprio texto
 * quando o tipo é informado. Devolve { tipo, chave } já no formato que o banco espera.
 */
function chavePix(v, tipo) {
  const t = String(v ?? '').trim();
  exigir(t && t.length <= 77, 'Informe a chave PIX.');
  const d = digitos(t);
  if (tipo === 'aleatoria' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    exigir(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t), 'Chave aleatória inválida (UUID).');
    return { tipo: 'aleatoria', chave: t.toLowerCase() };
  }
  if (t.includes('@')) {
    exigir(emailValido(t), 'Chave PIX de e-mail inválida.');
    return { tipo: 'email', chave: t.toLowerCase() };
  }
  if (d.length === 11 && cpfValido(d)) return { tipo: 'cpf', chave: d };
  if (d.length === 14) { exigir(cnpjValido(d), 'Chave PIX de CNPJ inválida.'); return { tipo: 'cnpj', chave: d }; }
  if (d.length >= 10 && d.length <= 13) return { tipo: 'telefone', chave: `+55${d.replace(/^55/, '')}` };
  return falhar('Chave PIX inválida (use CPF/CNPJ, celular, e-mail ou chave aleatória).');
}

/** Percentual com até 4 casas, guardado em pontos-base de centésimo (1% = 10000; 2,35% = 23500). */
const percentual = (v, nome, { max = 100 } = {}) => escalado(v, nome, 4, { max: max * 10000 });

/** CEP de 8 dígitos. */
function cep(v) {
  const d = digitos(v);
  exigir(d.length === 8, 'CEP inválido.');
  return d;
}

/** UF do Brasil. */
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
function uf(v) {
  const t = String(v ?? '').trim().toUpperCase();
  exigir(UFS.includes(t), 'UF inválida.');
  return t;
}
const ufOpcional = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : uf(v));

/** URL http(s) absoluta (endereço do IXC, webhook etc.). */
function url(v, nome) {
  const t = String(v ?? '').trim();
  let u;
  try { u = new URL(t); } catch { return falhar(`${nome[0].toUpperCase()}${nome.slice(1)} inválido (informe o endereço completo).`); }
  exigir(u.protocol === 'https:' || u.protocol === 'http:', `${nome[0].toUpperCase()}${nome.slice(1)} deve começar com http:// ou https://.`);
  return u.toString().replace(/\/+$/, '');
}
const urlOpcional = (v, nome) => (v === undefined || v === null || String(v).trim() === '' ? null : url(v, nome));

module.exports = { digitos, cpfValido, cnpjValido, emailValido, dataValida, exigir, falhar, texto, opcional, inteiro, numero, opcao, email, senha, telefone, data,
  horario, booleano, instante, instanteOpcional, dataOpcional, inteiroOpcional, centavos, centavosOpcional, escalado,
  documento, documentoOpcional, cnpj, chavePix, percentual, cep, uf, ufOpcional, url, urlOpcional };
