'use strict';

process.env.NODE_ENV = 'test';
process.env.NETWORK_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
process.env.NETWORK_LIMITE_LOGIN = '1000';
process.env.NETWORK_CONECTOR_REDE_INTERNA = '1';
process.env.NETWORK_CONECTOR_TIMEOUT_MS = '3000';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.NETWORK_ARQUIVOS = fs.mkdtempSync(path.join(os.tmpdir(), 'network-arquivos-'));

const { abrir } = require('../server/db');
const { criarApp } = require('../server/app');
const { criarOrganizacao } = require('../server/lib/organizacoes');
const { hashSenha } = require('../server/lib/senha');

// PNG de 1×1 e um PDF mínimo, para os anexos.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a1b30000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function iniciar() {
  const db = abrir(':memory:');
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const raiz = `http://127.0.0.1:${servidor.address().port}`;
  const base = `${raiz}/api`;

  async function req(metodo, caminho, corpo, tk, cabecalhos = {}) {
    const bruto = Buffer.isBuffer(corpo);
    const resp = await fetch(base + caminho, {
      method: metodo,
      headers: { ...(bruto ? {} : { 'Content-Type': 'application/json' }), ...(tk ? { Authorization: `Bearer ${tk}` } : {}), ...cabecalhos },
      body: corpo === undefined ? undefined : bruto ? corpo : JSON.stringify(corpo),
    });
    const texto = await resp.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* csv / vazio */ }
    return { status: resp.status, dados, headers: resp.headers };
  }
  async function login(email = 'admin@managernetwork.local', senha = 'admin12345') {
    const r = await req('POST', '/auth/login', { email, senha });
    if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${JSON.stringify(r.dados)}`);
    return r.dados.token;
  }
  const api = {
    db, raiz, req, login,
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk, h) => req('POST', c, b ?? {}, tk, h),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    put: (c, b, tk) => req('PUT', c, b, tk),
    fechar: () => new Promise((r) => servidor.close(r)),
  };

  /** Cria um usuário de cada perfil na organização do admin e devolve os tokens (e o técnico vinculado). */
  api.equipe = async () => {
    const admin = await login();
    const tk = { admin };
    for (const perfil of ['gestor', 'noc', 'frota', 'tecnico', 'comissoes', 'consulta']) {
      const r = await api.post('/organizacao/usuarios', { nome: `Usuário ${perfil}`, email: `${perfil}@teste.local`, senha: 'senha-teste-123', perfil }, admin);
      if (r.status !== 201) throw new Error(JSON.stringify(r.dados));
      tk[`${perfil}_id`] = r.dados.id;
      tk[perfil] = await login(`${perfil}@teste.local`, 'senha-teste-123');
    }
    tk.tecnico_tid = (await api.post('/equipe/tecnicos', { nome: 'Técnico Um', usuario_id: tk.tecnico_id, especialidades: 'Fibra' }, admin)).dados.id;
    tk.tecnico2_tid = (await api.post('/equipe/tecnicos', { nome: 'Técnico Dois' }, admin)).dados.id;
    return tk;
  };

  /** Outra organização com o próprio administrador (para testar o isolamento). */
  api.outraOrganizacao = async () => {
    const org = criarOrganizacao(db, { nome: 'Outro provedor' });
    db.prepare("INSERT INTO usuarios (organizacao_id, nome, email, senha_hash, perfil, criado_em) VALUES (?, 'Admin B', 'admin@outro.local', ?, 'admin', ?)")
      .run(org, hashSenha('senha-outro-123'), new Date().toISOString());
    return login('admin@outro.local', 'senha-outro-123');
  };
  return api;
}

module.exports = { iniciar, PNG, PDF };
