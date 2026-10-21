'use strict';

process.env.NODE_ENV = 'test';
process.env.PABX_SECRET = 'segredo-de-teste';
process.env.PABX_LIMITE_LOGIN = '1000';

const { abrir } = require('../server/db');
const { criarApp } = require('../server/app');

async function iniciar() {
  const db = abrir(':memory:');
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}${require('../server/config').basePath}/api`;

  async function req(metodo, caminho, corpo, tk, cabecalhos = {}) {
    const resp = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}), ...cabecalhos },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await resp.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* csv / vazio */ }
    return { status: resp.status, dados, headers: resp.headers };
  }

  async function login(email = 'master@pabx.com.br', senha = 'master123') {
    const r = await req('POST', '/auth/login', { email, senha });
    if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${JSON.stringify(r.dados)}`);
    return r.dados.token;
  }

  /** Chamadas da API de integração, com a chave da empresa. */
  const central = (chave) => ({
    get: (c) => req('GET', `/integracao${c}`, undefined, null, { 'X-Api-Key': chave }),
    post: (c, b) => req('POST', `/integracao${c}`, b ?? {}, null, { 'X-Api-Key': chave }),
  });

  return {
    db, req, login, central,
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk) => req('POST', c, b ?? {}, tk),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    put: (c, b, tk) => req('PUT', c, b, tk),
    del: (c, b, tk) => req('DELETE', c, b, tk),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

module.exports = { iniciar };
