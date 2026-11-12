'use strict';

process.env.NODE_ENV = 'test';
process.env.MERCADO_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
process.env.MERCADO_LIMITE_LOGIN = '1000';

const { abrir } = require('../server/db');
const { criarApp } = require('../server/app');

async function iniciar() {
  const db = abrir(':memory:');
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const raiz = `http://127.0.0.1:${servidor.address().port}`;
  const base = `${raiz}${require('../server/config').basePath}/api`;

  async function req(metodo, caminho, corpo, tk) {
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

  async function login(email = 'admin@mercadinho.com.br', senha = 'admin123') {
    const r = await req('POST', '/auth/login', { email, senha });
    if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${JSON.stringify(r.dados)}`);
    return r.dados.token;
  }

  /** Cria um usuário com o perfil pedido e já devolve o token dele. */
  async function criarUsuario(admin, { nome, email, perfil, senha = 'senha12345' }) {
    const r = await req('POST', '/admin/usuarios', { nome, email, perfil, senha }, admin);
    if (r.status !== 201) throw new Error(`Falha ao criar ${email}: ${JSON.stringify(r.dados)}`);
    return { usuario: r.dados, token: await login(email, senha) };
  }

  return {
    db, raiz, req, login, criarUsuario,
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk) => req('POST', c, b ?? {}, tk),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    del: (c, tk) => req('DELETE', c, undefined, tk),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

module.exports = { iniciar };
