'use strict';

process.env.NODE_ENV = 'test';
process.env.RASTREADOR_SECRET = 'segredo-de-teste';
process.env.RASTREADOR_LIMITE_LOGIN = '1000';

const { abrir } = require('../server/db');
const { criarApp } = require('../server/app');
const { iniciarGt06 } = require('../server/lib/gt06');

/** Servidor HTTP (e o GT06 numa porta livre) com banco em memória. */
async function iniciar() {
  const db = abrir(':memory:');
  const gt06 = iniciarGt06(db, 0, { host: '127.0.0.1' });
  await new Promise((r) => (gt06.servidor.listening ? r() : gt06.servidor.once('listening', r)));
  const servidor = criarApp(db, { gt06 }).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const raiz = `http://127.0.0.1:${servidor.address().port}${require('../server/config').basePath}`;
  const base = `${raiz}/api`;

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

  async function login(email = 'master@rastreador.com.br', senha = 'master123') {
    const r = await req('POST', '/auth/login', { email, senha });
    if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${JSON.stringify(r.dados)}`);
    return r.dados.token;
  }

  /** Posição pelo protocolo OsmAnd (como o app Traccar Client envia). */
  const osmand = (params) => fetch(`${base}/osmand?${new URLSearchParams(params)}`, { method: 'POST' });

  /** Chamadas da API de integração, com a chave da empresa. */
  const integracao = (chave) => ({
    get: (c) => req('GET', `/integracao${c}`, undefined, null, { 'X-Api-Key': chave }),
    post: (c, b) => req('POST', `/integracao${c}`, b ?? {}, null, { 'X-Api-Key': chave }),
  });

  return {
    db, req, login, osmand, integracao, raiz, portaGt06: gt06.servidor.address().port, gt06,
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk) => req('POST', c, b ?? {}, tk),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    put: (c, b, tk) => req('PUT', c, b, tk),
    del: (c, b, tk) => req('DELETE', c, b, tk),
    fechar: async () => { await gt06.fechar(); await new Promise((r) => servidor.close(r)); },
  };
}

module.exports = { iniciar };
