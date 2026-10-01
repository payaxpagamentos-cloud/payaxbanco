'use strict';

const { ErroNegocio } = require('./erros');

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

const digitos = (v) => String(v ?? '').replace(/\D/g, '');

function cpfValido(valor) {
  const cpf = digitos(valor);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(cpf[t])) return false;
  }
  return true;
}

function cnpjValido(valor) {
  const cnpj = digitos(valor);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (base) => {
    const pesos = base.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const soma = pesos.reduce((acc, p, i) => acc + Number(base[i]) * p, 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(cnpj.slice(0, 12));
  const d2 = calc(cnpj.slice(0, 12) + d1);
  return cnpj.endsWith(`${d1}${d2}`);
}

const emailValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? ''));
const dataValida = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(v));

function texto(v, max = 255) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function exigir(condicao, mensagem) {
  if (!condicao) throw new ErroNegocio(mensagem, 422);
}

function valorCentavos(v, campo = 'valor') {
  const n = Number(v);
  exigir(Number.isInteger(n) && n > 0, `O ${campo} deve ser um inteiro positivo em centavos.`);
  exigir(n <= 100_000_000_000, `O ${campo} excede o máximo permitido.`);
  return n;
}

module.exports = { UFS, digitos, cpfValido, cnpjValido, emailValido, dataValida, texto, exigir, valorCentavos };
