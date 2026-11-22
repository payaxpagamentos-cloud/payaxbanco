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
const maiuscula = (n) => `${n[0].toUpperCase()}${n.slice(1)}`;

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

/** Avisos do rodapé da TV: um por linha, até 6, cada um com tamanho limitado. Devolve o texto pronto (ou null). */
const avisos = (v, maxCada = 200) => {
  const linhas = String(v ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/[\u0000-\u001f]/g, '').trim()).filter(Boolean);
  exigir(linhas.length <= 6, 'Use no máximo 6 avisos (um por linha).');
  for (const l of linhas) exigir(l.length <= maxCada, `Cada aviso pode ter até ${maxCada} letras.`);
  return linhas.length ? linhas.join('\n') : null;
};

const senha = (v) => {
  exigir(typeof v === 'string' && v.length >= 10, 'A senha deve ter pelo menos 10 caracteres.');
  exigir(v.length <= 200, 'Senha longa demais.');
  return v;
};

const telefone = (v) => {
  const t = digitos(v);
  exigir(t.length >= 10 && t.length <= 13, 'Telefone inválido (informe DDD e número).');
  return t;
};

const data = (v, nome) => {
  exigir(dataValida(v), `${maiuscula(nome)} inválida (use AAAA-MM-DD).`);
  return v;
};

/** CNPJ ou CPF do anunciante / do ponto (guardado só com dígitos). */
function documento(v, nome = 'o CNPJ/CPF') {
  const d = digitos(v);
  exigir(d.length === 11 ? cpfValido(d) : d.length === 14 && cnpjValido(d), `${maiuscula(nome)} inválido.`);
  return d;
}

/** Hora 'HH:MM' (00:00 a 23:59). */
function hora(v, nome = 'a hora') {
  const h = String(v ?? '').trim();
  exigir(/^([01]\d|2[0-3]):[0-5]\d$/.test(h), `${maiuscula(nome)} inválida (use HH:MM).`);
  return h;
}

/** Competência 'AAAA-MM'. */
function competencia(v) {
  const c = String(v ?? '').trim();
  exigir(/^\d{4}-(0[1-9]|1[0-2])$/.test(c), 'Competência inválida (use AAAA-MM).');
  return c;
}

/** Percentual em centésimos: 15 ou "15,5" viram 1500 e 1550. */
function percentual(v, nome = 'o percentual', max = 100) {
  const n = numero(v, nome, { min: 0, max });
  return Math.round(n * 100);
}

/** Dias da semana em que a campanha vai ao ar: '0'..'6' (0 = domingo), sem repetição. */
function diasSemana(v) {
  const bruto = Array.isArray(v) ? v : String(v ?? '').trim();
  // Aceita lista (['1','2']), compacto ('0123456') ou separado por vírgula/espaço ('1, 2 3').
  const lista = Array.isArray(bruto) ? bruto.map(String) : (/^[0-6]+$/.test(bruto) ? [...bruto] : bruto.split(/[,;\s]+/));
  const dias = [...new Set(lista.map((d) => String(d).trim()).filter((d) => d !== ''))].sort();
  exigir(dias.length && dias.every((d) => /^[0-6]$/.test(d)), 'Dias da semana inválidos.');
  return dias.join('');
}

/** UF de duas letras. */
function uf(v) {
  const u = String(v ?? '').trim().toUpperCase();
  exigir(/^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(u), 'UF inválida.');
  return u;
}

/**
 * Ambientes onde a rede instala telas. A lista mora aqui (e não numa restrição do banco) para crescer
 * sem migração; o painel mostra os rótulos de CATEGORIAS em public/js/ui.js.
 */
const CATEGORIAS = ['condominio_residencial', 'condominio_comercial', 'predio_corporativo', 'academia', 'mercado', 'padaria', 'farmacia',
  'clinica', 'hospital', 'universidade', 'escola', 'salao', 'restaurante', 'lanchonete', 'loja', 'shopping', 'posto', 'oficina',
  'aeroporto', 'transporte', 'rua', 'predio', 'outro'];

/** Posição da tela dentro do ponto (elevador social, hall, portaria...). Texto livre, com sugestões no painel. */
const posicao = (v) => opcional(v, 'a posição da tela', 60);

const booleano = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

module.exports = { digitos, cpfValido, cnpjValido, emailValido, dataValida, exigir, falhar, texto, opcional, inteiro, numero, opcao, email, senha, avisos, telefone, data,
  documento, hora, competencia, percentual, diasSemana, uf, booleano, CATEGORIAS, posicao };
