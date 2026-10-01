'use strict';

/* Regras do cadastro de clientes, compartilhadas pela equipe (Banqueiro) e pela abertura de conta online. */
const v = require('./validacao');

const CAMPOS = ['tipo','nome','documento','email','telefone','data_nascimento','renda_mensal_centavos',
  'cep','logradouro','numero','complemento','bairro','cidade','uf','status','observacoes'];

function normalizar(body, atual = {}) {
  const d = { ...atual, ...body };
  const c = {
    tipo: d.tipo,
    nome: v.texto(d.nome, 150),
    documento: v.digitos(d.documento),
    email: v.texto(d.email, 150)?.toLowerCase() ?? null,
    telefone: v.digitos(d.telefone) || null,
    data_nascimento: v.texto(d.data_nascimento, 10),
    renda_mensal_centavos: Number(d.renda_mensal_centavos ?? 0),
    cep: v.digitos(d.cep) || null,
    logradouro: v.texto(d.logradouro, 150),
    numero: v.texto(d.numero, 20),
    complemento: v.texto(d.complemento, 80),
    bairro: v.texto(d.bairro, 80),
    cidade: v.texto(d.cidade, 80),
    uf: v.texto(d.uf, 2)?.toUpperCase() ?? null,
    status: d.status || 'ativo',
    observacoes: v.texto(d.observacoes, 1000),
  };
  v.exigir(['PF','PJ'].includes(c.tipo), 'Tipo de cliente deve ser PF ou PJ.');
  v.exigir(c.nome && c.nome.length >= 3, 'Informe o nome completo / razão social.');
  v.exigir(c.tipo === 'PF' ? v.cpfValido(c.documento) : v.cnpjValido(c.documento),
    c.tipo === 'PF' ? 'CPF inválido.' : 'CNPJ inválido.');
  v.exigir(!c.email || v.emailValido(c.email), 'E-mail inválido.');
  v.exigir(!c.telefone || (c.telefone.length >= 10 && c.telefone.length <= 11), 'Telefone deve ter DDD + número.');
  v.exigir(!c.data_nascimento || v.dataValida(c.data_nascimento), 'Data de nascimento/fundação inválida.');
  v.exigir(Number.isInteger(c.renda_mensal_centavos) && c.renda_mensal_centavos >= 0, 'Renda/faturamento inválido.');
  v.exigir(!c.cep || c.cep.length === 8, 'CEP deve ter 8 dígitos.');
  v.exigir(!c.uf || v.UFS.includes(c.uf), 'UF inválida.');
  v.exigir(['ativo','inativo','bloqueado'].includes(c.status), 'Status inválido.');
  return c;
}

function inserirCliente(db, c) {
  const r = db.prepare(`INSERT INTO clientes (${CAMPOS.join(', ')}) VALUES (${CAMPOS.map(() => '?').join(', ')})`)
    .run(...CAMPOS.map((k) => c[k]));
  return Number(r.lastInsertRowid);
}

module.exports = { CAMPOS, normalizar, inserirCliente };
