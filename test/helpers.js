'use strict';

process.env.NODE_ENV = 'test';
process.env.BPO_SECRET = 'segredo-de-teste';
process.env.BPO_LIMITE_LOGIN = '1000';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpo-teste-'));
process.env.BPO_ARQUIVOS = path.join(temp, 'arquivos');
process.env.BPO_BACKUPS = path.join(temp, 'backups');
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));

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

  /** Envio de arquivo (corpo binário, metadados na query). */
  async function enviarArquivo(caminho, conteudo, tk = token) {
    const resp = await fetch(base + caminho, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tk}` }, body: conteudo });
    const texto = await resp.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* vazio */ }
    return { status: resp.status, dados };
  }

  async function login(email = 'admin@ativabpo.com.br', senha = 'admin123') {
    const r = await req('POST', '/auth/login', { email, senha }, null);
    if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${JSON.stringify(r.dados)}`);
    return r.dados.token;
  }

  token = await login();

  return {
    db, req, login, enviarArquivo,
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk) => req('POST', c, b, tk),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    del: (c, tk) => req('DELETE', c, undefined, tk),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

/** Data relativa a hoje (horário de Brasília). */
const dia = (deslocamento = 0) => require('../server/lib/datas').somarDias(require('../server/lib/datas').hoje(), deslocamento);

module.exports = { iniciar, dia };
