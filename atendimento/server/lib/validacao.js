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

/** Número de telefone: só dígitos, de 8 a 15, com o + opcional removido. */
function numeroTelefone(v, nome = 'o número') {
  const t = digitos(v);
  exigir(t.length >= 8 && t.length <= 15, `${nome[0].toUpperCase()}${nome.slice(1)} inválido.`);
  return t;
}

/**
 * Número do WhatsApp no formato da Cloud API (wa_id): só dígitos, com código do país.
 * Um número brasileiro digitado sem o país (10 ou 11 dígitos) recebe o 55.
 */
function whatsapp(v, nome = 'o número do WhatsApp') {
  const d = digitos(v);
  const comPais = d.length === 10 || d.length === 11 ? `55${d}` : d;
  exigir(comPais.length >= 10 && comPais.length <= 15, `${nome[0].toUpperCase()}${nome.slice(1)} inválido.`);
  return comPais;
}

/** Hora do dia 'HH:MM' (horário de atendimento). */
function horario(v, nome = 'o horário') {
  const t = String(v ?? '').trim();
  exigir(/^([01]\d|2[0-3]):[0-5]\d$/.test(t), `${nome[0].toUpperCase()}${nome.slice(1)} inválido (use HH:MM).`);
  return t;
}

/** Dias da semana como string de 7 caracteres 0/1 começando no domingo (ex.: '0111110' = seg a sex). */
function diasSemana(v, nome = 'os dias de atendimento') {
  const t = String(v ?? '').trim();
  exigir(/^[01]{7}$/.test(t), `${nome[0].toUpperCase()}${nome.slice(1)} inválidos.`);
  return t;
}

/** Lista de textos separados por vírgula ou linha (palavras-chave, etiquetas). Devolve array sem repetições. */
function lista(v, nome, { max = 40, maxItem = 120 } = {}) {
  const itens = [...new Set(String(v ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, maxItem)))];
  exigir(itens.length <= max, `${nome[0].toUpperCase()}${nome.slice(1)}: no máximo ${max} itens.`);
  return itens;
}

/** Endereço externo (ferramenta da empresa, webhook): sempre https, sem usuário e senha na URL. */
function endereco(v, nome = 'o endereço') {
  const t = texto(v, nome, 500);
  let u;
  try { u = new URL(t); } catch { falhar(`${nome[0].toUpperCase()}${nome.slice(1)} inválido.`); }
  const http = process.env.NODE_ENV === 'test' || process.env.ATEND_HTTP === '1';
  exigir(u.protocol === 'https:' || (http && u.protocol === 'http:'), `${nome[0].toUpperCase()}${nome.slice(1)} deve começar com https://.`);
  exigir(!u.username && !u.password, `${nome[0].toUpperCase()}${nome.slice(1)} não pode ter usuário e senha.`);
  return u.toString();
}

/** Nome de ferramenta da IA: letras minúsculas, números e _ (é o nome que o modelo chama). */
function nomeFerramenta(v) {
  const t = String(v ?? '').trim().toLowerCase();
  exigir(/^[a-z][a-z0-9_]{2,48}$/.test(t), 'Nome da ferramenta inválido (use letras minúsculas, números e _, de 3 a 49 caracteres).');
  return t;
}

/** JSON de objeto (parâmetros de ferramenta, cabeçalhos). Aceita objeto ou texto. */
function objeto(v, nome) {
  if (v === undefined || v === null || v === '') return null;
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { falhar(`${nome[0].toUpperCase()}${nome.slice(1)}: JSON inválido.`); } }
  exigir(o && typeof o === 'object' && !Array.isArray(o), `${nome[0].toUpperCase()}${nome.slice(1)} deve ser um objeto JSON.`);
  return o;
}

const booleano = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

module.exports = { digitos, cpfValido, cnpjValido, emailValido, dataValida, exigir, falhar, texto, opcional, inteiro, numero, opcao, email, senha, telefone, data,
  numeroTelefone, whatsapp, horario, diasSemana, lista, endereco, nomeFerramenta, objeto, booleano };
