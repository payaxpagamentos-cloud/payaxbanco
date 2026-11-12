'use strict';

process.env.NODE_ENV = 'test';
process.env.PDV_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
process.env.PDV_LIMITE_LOGIN = '1000';
process.env.PDV_HTTP = '1';

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

  async function login(email = 'master@pdv.com.br', senha = 'master123') {
    const r = await req('POST', '/auth/login', { email, senha });
    if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${JSON.stringify(r.dados)}`);
    return r.dados.token;
  }

  /** Chamadas da maquininha (API de integração), com a chave do terminal. */
  const terminal = (chave) => ({
    get: (c) => req('GET', `/integracao${c}`, undefined, null, { 'X-Api-Key': chave }),
    post: (c, b) => req('POST', `/integracao${c}`, b ?? {}, null, { 'X-Api-Key': chave }),
  });

  return {
    db, base, req, login, terminal,
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk) => req('POST', c, b ?? {}, tk),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    del: (c, b, tk) => req('DELETE', c, b, tk),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

/**
 * Empresa pronta para os testes: loja, PDV, usuários (admin, supervisor, operador), configuração do IXC
 * e, quando pedido, uma maquininha com chave.
 */
async function empresaDeTeste(app, { ixcUrl, ixcToken, terminal: comTerminal = true, modo = 'agente' } = {}) {
  const master = await app.login();
  const empresa = (await app.post('/master/empresas', { nome: 'Provedor Teste', documento: '11.444.777/0001-61' }, master)).dados;
  const eid = empresa.id;
  const lojas = (await app.get(`/empresas/${eid}/cadastros/lojas`, master)).dados.itens;
  const pdvs = (await app.get(`/empresas/${eid}/cadastros/pdvs`, master)).dados.itens;
  const senha = 'pdv12345';
  for (const [perfil, email] of [['admin', 'admin@provedor.com.br'], ['supervisor', 'supervisor@provedor.com.br'], ['operador', 'caixa@provedor.com.br']]) {
    const r = await app.post(`/empresas/${eid}/cadastros/usuarios`, { nome: perfil, email, senha, perfil, loja_id: lojas[0].id }, master);
    if (r.status !== 201) throw new Error(`Falha criando ${perfil}: ${JSON.stringify(r.dados)}`);
  }
  if (ixcUrl) {
    const r = await app.patch(`/empresas/${eid}/configuracoes`, {
      ixc_url: ixcUrl, ixc_token: ixcToken, ixc_ativo: true, ixc_tipos_recebimento: { dinheiro: '1', pix: '5', debito: '3', credito: '4' }, ixc_conta_id: '2',
    }, master);
    if (r.status !== 200) throw new Error(`Falha configurando IXC: ${JSON.stringify(r.dados)}`);
  }
  let maquininha = null;
  if (comTerminal) {
    const r = await app.post(`/empresas/${eid}/cadastros/terminais`, { nome: 'Maquininha 1', loja_id: lojas[0].id, pdv_id: pdvs[0].id, adquirente: 'stone', modo }, master);
    if (r.status !== 201) throw new Error(`Falha criando maquininha: ${JSON.stringify(r.dados)}`);
    maquininha = r.dados;
  }
  return {
    eid, master, loja: lojas[0], pdv: pdvs[0], maquininha, senha,
    admin: await app.login('admin@provedor.com.br', senha),
    supervisor: await app.login('supervisor@provedor.com.br', senha),
    operador: await app.login('caixa@provedor.com.br', senha),
  };
}

module.exports = { iniciar, empresaDeTeste };
