'use strict';

process.env.NODE_ENV = 'test';
process.env.PAYAX_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
process.env.PAYAX_LIMITE_LOGIN = '1000';
process.env.PAYAX_BANCO_MODO = 'simulador';
process.env.PAYAX_IXC_REDE_INTERNA = '1'; // o IXC falso dos testes roda em 127.0.0.1

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.PAYAX_BACKUPS = fs.mkdtempSync(path.join(os.tmpdir(), 'payax-backups-'));
const baseCnab = fs.mkdtempSync(path.join(os.tmpdir(), 'payax-cnab-'));
process.env.PAYAX_CNAB_REMESSA = path.join(baseCnab, 'remessa');
process.env.PAYAX_CNAB_RETORNO = path.join(baseCnab, 'retorno');
process.env.PAYAX_CNAB_PROCESSADOS = path.join(baseCnab, 'processados');
for (const d of [process.env.PAYAX_CNAB_REMESSA, process.env.PAYAX_CNAB_RETORNO, process.env.PAYAX_CNAB_PROCESSADOS]) fs.mkdirSync(d, { recursive: true });
process.env.PAYAX_BACKUP = '0'; // nos testes o backup é chamado direto, não por rotina

const { abrir, agora } = require('../server/db');
const { criarApp } = require('../server/app');
const { hashSenha } = require('../server/lib/senha');

const CNPJ = { alfa: '11122233000183', beta: '19131243000197', payax: '12345678000195' };
const CPF = '11144477735';

async function iniciar() {
  const db = abrir(':memory:');
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const raiz = `http://127.0.0.1:${servidor.address().port}`;

  async function req(metodo, caminho, corpo, tk, cabecalhos = {}) {
    // Buffer vai como corpo bruto (arquivo de retorno); o resto vai como JSON.
    const bruto = Buffer.isBuffer(corpo);
    const resp = await fetch(raiz + caminho, {
      method: metodo,
      headers: {
        ...(bruto ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }),
        ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
        ...cabecalhos,
      },
      body: corpo === undefined ? undefined : bruto ? corpo : JSON.stringify(corpo),
    });
    const texto = await resp.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* csv ou html */ }
    return { status: resp.status, dados, headers: resp.headers };
  }

  const api = {
    db, raiz, req,
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk, h) => req('POST', c, b ?? {}, tk, h),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    put: (c, b, tk) => req('PUT', c, b, tk),
    fechar: () => new Promise((r) => servidor.close(r)),
  };

  /** Equipe: admin (senha já definitiva) e um usuário de cada perfil. */
  api.equipe = async () => {
    db.prepare("UPDATE usuarios SET senha_provisoria = 0 WHERE email = 'admin@payax.local'").run();
    const entrar = async (email, senha) => {
      const r = await api.post('/api/auth/login', { email, senha });
      if (r.status !== 200) throw new Error(`Login falhou (${email}): ${JSON.stringify(r.dados)}`);
      return r.dados.token;
    };
    const tk = { admin: await entrar('admin@payax.local', 'admin12345') };
    for (const perfil of ['financeiro', 'operacao', 'consulta']) {
      const r = await api.post('/api/admin/usuarios', { nome: `Usuário ${perfil}`, email: `${perfil}@payax.local`, senha: 'senha-de-teste-1', perfil }, tk.admin);
      if (r.status !== 201) throw new Error(JSON.stringify(r.dados));
      db.prepare('UPDATE usuarios SET senha_provisoria = 0 WHERE id = ?').run(r.dados.id);
      tk[perfil] = await entrar(`${perfil}@payax.local`, 'senha-de-teste-1');
      tk[`${perfil}_id`] = r.dados.id;
    }
    return tk;
  };

  /** Conta bancária nossa + tabela de preços padrão. */
  api.conta = async (tk, extra = {}) => {
    const r = await api.post('/api/contas', {
      apelido: 'Bradesco teste', agencia: '3391', conta: '0006688', cedente: '1234567',
      beneficiario_nome: 'PAY AX Brasil Ltda', beneficiario_documento: CNPJ.payax,
      beneficiario_cidade: 'Praia Grande', pix_chave: CNPJ.payax, custo_liquidacao: '1,90', ...extra,
    }, tk);
    if (r.status !== 201) throw new Error(JSON.stringify(r.dados));
    return r.dados;
  };

  api.precoPadrao = (tk, p = {}) => api.post('/api/contas/precos-padrao', {
    tarifa_emissao: '0,00', tarifa_liquidacao: '2,50', percentual: '2,35', comissao_minima: '1,00', tarifa_repasse: '0,00', ...p,
  }, tk);

  /** Cliente ativo com acesso ao Internet Bank. Devolve { cliente, token, senha }. */
  api.cliente = async (tk, dados = {}) => {
    const c = await api.post('/api/clientes', {
      razao_social: 'Provedor Alfa LTDA', nome_fantasia: 'Alfa Net', cnpj: CNPJ.alfa, situacao: 'ativo',
      pix_chave: CNPJ.alfa, limite_boleto: '20.000,00', ...dados,
    }, tk);
    if (c.status !== 201) throw new Error(JSON.stringify(c.dados));
    const acesso = await api.post(`/api/clientes/${c.dados.id}/acessos`, {
      nome: 'Financeiro Alfa', email: `financeiro${c.dados.id}@alfa.test`, perfil: 'admin',
    }, tk);
    db.prepare('UPDATE usuarios_cliente SET senha_provisoria = 0 WHERE id = ?').run(acesso.dados.id);
    const login = await api.post('/cliente/api/auth/login', { email: acesso.dados.email, senha: acesso.dados.senha_provisoria });
    return { cliente: c.dados, acesso: acesso.dados, token: login.dados.token };
  };

  /** Boleto emitido pelo backoffice. */
  api.boleto = async (tk, clienteId, dados = {}) => {
    const r = await api.post('/api/boletos', {
      cliente_id: clienteId, tipo: 'bolepix', valor: '100,00', vencimento: '2026-12-20',
      pagador_nome: 'Maria Souza', pagador_documento: CPF, pagador_cidade: 'Santos', pagador_uf: 'SP', ...dados,
    }, tk);
    if (r.status !== 201) throw new Error(JSON.stringify(r.dados));
    return r.dados;
  };

  /** Token do webhook do banco (cadastra a integração se preciso). */
  api.tokenWebhook = async (tk) => {
    const r = await api.put('/api/integracoes/banco', { ambiente: 'homologacao' }, tk);
    return r.dados.webhook_caminho.split('/').pop();
  };

  return api;
}

module.exports = { iniciar, CNPJ, CPF, agora };
