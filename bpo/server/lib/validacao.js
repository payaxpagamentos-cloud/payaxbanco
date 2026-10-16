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
    const pesos = base.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const r = pesos.reduce((acc, p, i) => acc + Number(base[i]) * p, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(cnpj.slice(0, 12));
  const d2 = calc(cnpj.slice(0, 12) + d1);
  return cnpj.endsWith(`${d1}${d2}`);
}

const emailValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? ''));

/** Data de negócio 'AAAA-MM-DD' que existe no calendário. */
function dataValida(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function texto(v, max = 255) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function exigir(condicao, mensagem) {
  if (!condicao) throw new ErroNegocio(mensagem, 422);
}

function valorCentavos(v, campo = 'valor', { zero = false } = {}) {
  const n = Number(v);
  exigir(Number.isInteger(n) && (zero ? n >= 0 : n > 0), `O ${campo} deve ser um inteiro ${zero ? 'não negativo' : 'positivo'} em centavos.`);
  exigir(n <= 100_000_000_000, `O ${campo} excede o máximo permitido.`);
  return n;
}

function data(v, campo) {
  exigir(dataValida(v), `Informe ${campo} válida (AAAA-MM-DD).`);
  return v;
}

/** Documento opcional de contato: CPF ou CNPJ válido, ou vazio. */
function documentoOpcional(v) {
  const d = digitos(v);
  if (!d) return null;
  exigir((d.length === 11 && cpfValido(d)) || (d.length === 14 && cnpjValido(d)), 'CPF/CNPJ inválido.');
  return d;
}

const id = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

module.exports = { digitos, cpfValido, cnpjValido, emailValido, dataValida, texto, exigir, valorCentavos, data, documentoOpcional, id };
