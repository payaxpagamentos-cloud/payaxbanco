'use strict';

process.env.NODE_ENV = 'test';
process.env.PAYAX_SECRET = 'segredo-de-teste';

const { abrir } = require('../server/db');
const { criarApp } = require('../server/app');

async function iniciar() {
  const db = abrir(':memory:');
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}/api`;
  let token = null;

  async function req(metodo, caminho, corpo, tk = token) {
    const resp = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await resp.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* csv / vazio */ }
    return { status: resp.status, dados, headers: resp.headers };
  }

  async function login(email = 'admin@payax.com.br', senha = 'admin123') {
    const r = await req('POST', '/auth/login', { email, senha }, null);
    return r.dados.token;
  }

  token = await login();
  return {
    db, req, login,
    usarToken: (t) => { token = t; },
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk) => req('POST', c, b, tk),
    put: (c, b, tk) => req('PUT', c, b, tk),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    del: (c, tk) => req('DELETE', c, undefined, tk),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

module.exports = { iniciar };
