'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const empresasLib = require('../server/lib/empresas');

/** Permissões, isolamento entre empresas e a API de integração — pela HTTP, como o cliente usa. */
describe('API', () => {
  let meta;
  let db;
  let ambiente;
  let servidor;
  let base;
  let outra;
  const tokens = {};

  before(async () => {
    meta = h.fingirMeta();
    ambiente = h.criarAmbiente();
    ({ db } = ambiente);
    // Uma segunda empresa, para provar que uma não enxerga a outra.
    outra = empresasLib.criar(db, { nome: 'Outra Empresa' }, { comExemplos: false });
    empresasLib.criarUsuario(db, outra.id, { nome: 'Alheio', email: 'alheio@outra.com.br', perfil: 'cliente', senha: 'senha12345' });
    empresasLib.salvarNumero(db, outra.id, { nome: 'Outro', telefone: '1144445555', phone_number_id: '999000111222333', token: 'token-outra' });

    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;

    for (const [papel, email, senha] of [
      ['master', 'master@atendimento.com.br', 'master123'],
      ['admin', 'carlos@fibramais.com.br', 'senha12345'],
      ['atendente', 'marina@fibramais.com.br', 'senha12345'],
      ['alheio', 'alheio@outra.com.br', 'senha12345'],
    ]) {
      const r = await (await chamar('POST', '/auth/login', { email, senha })).json();
      tokens[papel] = r.token;
    }
    // Um supervisor, para conferir o modo só leitura.
    const sup = empresasLib.criarUsuario(db, ambiente.empresa.id, { nome: 'Beatriz', email: 'bia@fibramais.com.br', perfil: 'supervisor', senha: 'senha12345' });
    tokens.supervisor = (await (await chamar('POST', '/auth/login', { email: sup.usuario.email, senha: 'senha12345' })).json()).token;
  });

  after(async () => {
    meta.restaurar();
    await new Promise((r) => servidor.close(r));
  });

  const chamar = (metodo, caminho, corpo, token) => fetch(`${base}/api${caminho}`, {
    method: metodo,
    headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });

  test('sem token não entra', async () => {
    assert.equal((await chamar('GET', '/empresas/1/conversas')).status, 401);
    assert.equal((await chamar('GET', '/master/painel')).status, 401);
  });

  test('login errado não conta se o e-mail existe', async () => {
    const inexistente = await chamar('POST', '/auth/login', { email: 'ninguem@lugar.com', senha: 'x' });
    const senhaErrada = await chamar('POST', '/auth/login', { email: 'carlos@fibramais.com.br', senha: 'errada' });
    assert.equal(inexistente.status, 401);
    assert.equal(senhaErrada.status, 401);
    assert.equal((await inexistente.json()).erro, (await senhaErrada.json()).erro);
  });

  test('uma empresa não enxerga a outra', async () => {
    const r = await chamar('GET', `/empresas/${outra.id}/conversas`, null, tokens.admin);
    assert.equal(r.status, 404, 'nem existe, do ponto de vista dela');
    const inverso = await chamar('GET', `/empresas/${ambiente.empresa.id}/conversas`, null, tokens.alheio);
    assert.equal(inverso.status, 404);
  });

  test('a equipe da plataforma entra em qualquer empresa', async () => {
    assert.equal((await chamar('GET', `/empresas/${ambiente.empresa.id}/painel`, null, tokens.master)).status, 200);
    assert.equal((await chamar('GET', `/empresas/${outra.id}/painel`, null, tokens.master)).status, 200);
  });

  test('o supervisor só consulta', async () => {
    assert.equal((await chamar('GET', `/empresas/${ambiente.empresa.id}/conversas`, null, tokens.supervisor)).status, 200);
    const tentativa = await chamar('POST', `/empresas/${ambiente.empresa.id}/filas`, { nome: 'Nova' }, tokens.supervisor);
    assert.equal(tentativa.status, 403);
    assert.match((await tentativa.json()).erro, /só pode consultar/i);
  });

  test('o atendente não administra a empresa', async () => {
    const fila = await chamar('POST', `/empresas/${ambiente.empresa.id}/filas`, { nome: 'Nova' }, tokens.atendente);
    assert.equal(fila.status, 403);
    const ia = await chamar('PATCH', `/empresas/${ambiente.empresa.id}/ia`, { ativa: false }, tokens.atendente);
    assert.equal(ia.status, 403);
    // Mas atende: consegue ver a caixa de entrada e criar resposta rápida.
    assert.equal((await chamar('GET', `/empresas/${ambiente.empresa.id}/conversas`, null, tokens.atendente)).status, 200);
  });

  test('só o master cria e exclui empresa', async () => {
    assert.equal((await chamar('POST', '/master/empresas', { nome: 'Pelo admin' }, tokens.admin)).status, 403);
    const criada = await chamar('POST', '/master/empresas', { nome: 'Terceira Empresa' }, tokens.master);
    assert.equal(criada.status, 201);
    const empresa = await criada.json();
    // Exclusão exige o nome exato.
    const errada = await chamar('DELETE', `/master/empresas/${empresa.id}`, { confirmar_nome: 'errado' }, tokens.master);
    assert.equal(errada.status, 400);
    assert.match((await errada.json()).erro, /nome exato/);
    assert.equal((await chamar('DELETE', `/master/empresas/${empresa.id}`, { confirmar_nome: 'Terceira Empresa' }, tokens.master)).status, 200);
  });

  test('a ZOE nova nasce configurada e com filas', async () => {
    const empresa = await (await chamar('POST', '/master/empresas', { nome: 'Quarta Empresa' }, tokens.master)).json();
    const ia = await (await chamar('GET', `/empresas/${empresa.id}/ia`, null, tokens.master)).json();
    assert.equal(ia.ativa, true);
    assert.equal(ia.nome_assistente, 'ZOE');
    assert.ok(ia.fila_padrao_id, 'já tem fila padrão');
    const filas = await (await chamar('GET', `/empresas/${empresa.id}/filas`, null, tokens.master)).json();
    assert.deepEqual(filas.itens.map((f) => f.nome), ['Atendimento', 'Financeiro']);
  });

  test('o prompt da IA é auditável pelo painel', async () => {
    const r = await (await chamar('GET', `/empresas/${ambiente.empresa.id}/ia/prompt`, null, tokens.admin)).json();
    // O prompt preserva o papel como o cliente lê: 'ZOE, a atendente virtual da Fibra Mais'.
    assert.match(r.sistema, /ZOE, a atendente virtual da Fibra Mais/);
    assert.match(r.sistema, /transferir_para_humano|Transfira para uma pessoa/);
    assert.ok(r.ferramentas.some((f) => f.nome === 'transferir_para_humano'));
    assert.ok(r.ferramentas.some((f) => f.nome === 'buscar_conhecimento'));
  });

  test('o número devolve os dados sem nunca expor o token', async () => {
    const r = await (await chamar('GET', `/empresas/${ambiente.empresa.id}/numeros`, null, tokens.admin)).json();
    const n = r.itens[0];
    assert.equal(n.token_configurado, true);
    assert.equal(n.app_secret_configurado, true);
    assert.equal(JSON.stringify(r).includes('EAAG-token-de-teste'), false, 'o token não vai para o painel');
    assert.ok(r.webhook.url.endsWith('/api/webhook'));
  });

  test('mensagem livre fora da janela de 24 h é recusada com explicação', async () => {
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const c = h.conversaDoCliente(db);
      db.prepare('UPDATE conversas SET janela_expira_em = NULL WHERE id = ?').run(c.id);
      const r = await chamar('POST', `/empresas/${ambiente.empresa.id}/conversas/${c.id}/mensagens`, { texto: 'oi de novo' }, tokens.admin);
      assert.equal(r.status, 409);
      assert.match((await r.json()).erro, /template aprovado/);
    } finally { sem.restaurar(); }
  });

  test('a resposta rápida /atalho vira o texto cadastrado', async () => {
    const sem = h.semIa();
    try {
      await chamar('POST', `/empresas/${ambiente.empresa.id}/respostas-rapidas`,
        { atalho: 'boleto', titulo: 'Boleto', texto: 'A segunda via está na área do cliente.' }, tokens.admin);
      await h.conversar(db, 'preciso de ajuda');
      const c = h.conversaDoCliente(db);
      const r = await chamar('POST', `/empresas/${ambiente.empresa.id}/conversas/${c.id}/mensagens`, { texto: '/boleto' }, tokens.admin);
      assert.equal(r.status, 201);
      assert.match((await r.json()).texto, /segunda via está na área do cliente/);
      const inexistente = await chamar('POST', `/empresas/${ambiente.empresa.id}/conversas/${c.id}/mensagens`, { texto: '/naoexiste' }, tokens.admin);
      assert.equal(inexistente.status, 400);
      assert.match((await inexistente.json()).erro, /\/naoexiste.*não encontrada/);
    } finally { sem.restaurar(); }
  });

  // ---------- API de integração ----------

  test('a integração exige chave válida e só enxerga a própria empresa', async () => {
    const semChave = await fetch(`${base}/api/integracao/conversas`);
    assert.equal(semChave.status, 401);

    const nova = await (await chamar('POST', `/empresas/${ambiente.empresa.id}/chaves`, { nome: 'ERP' }, tokens.admin)).json();
    assert.match(nova.chave, /^atd_/);

    const comChave = (caminho, metodo = 'GET', corpo = null) => fetch(`${base}/api/integracao${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${nova.chave}`, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });

    const saude = await (await comChave('/saude')).json();
    assert.equal(saude.empresa, 'Fibra Mais');

    const conversas = await (await comChave('/conversas')).json();
    assert.ok(Array.isArray(conversas.itens));
    assert.equal(conversas.itens.every((c) => c.id), true);

    // Cadastra um contato pelo ERP.
    const contato = await (await comChave('/contatos', 'POST', { telefone: '11955554444', nome: 'Cliente do ERP', documento: '12345678909', codigo_externo: 'ERP-77' })).json();
    assert.equal(contato.telefone, '5511955554444');
    assert.equal(contato.codigo_externo, 'ERP-77');

    // Sem janela aberta, mensagem livre é recusada com a explicação da regra da Meta.
    const livre = await comChave('/mensagens', 'POST', { telefone: '11955554444', texto: 'Olá!' });
    assert.equal(livre.status, 422);
    assert.match((await livre.json()).erro, /template aprovado/);

    // Com template, entra na fila de envio.
    const comTemplate = await comChave('/mensagens', 'POST', { telefone: '11955554444', template: 'aviso_fatura', parametros: ['João'] });
    assert.equal(comTemplate.status, 202);
    const envio = await comTemplate.json();
    assert.ok(envio.conversa_id);

    // A chave revogada para de funcionar.
    const lista = await (await chamar('GET', `/empresas/${ambiente.empresa.id}/chaves`, null, tokens.admin)).json();
    await chamar('DELETE', `/empresas/${ambiente.empresa.id}/chaves/${lista.itens[0].id}`, null, tokens.admin);
    assert.equal((await comChave('/saude')).status, 401);
  });

  test('a conversa aberta pela integração não passa pela IA, a menos que peçam', async () => {
    const nova = await (await chamar('POST', `/empresas/${ambiente.empresa.id}/chaves`, { nome: 'ERP 2' }, tokens.admin)).json();
    const comChave = (caminho, corpo) => fetch(`${base}/api/integracao${caminho}`, {
      method: 'POST', headers: { Authorization: `Bearer ${nova.chave}`, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    });
    const r = await (await comChave('/mensagens', { telefone: '11944443333', template: 'aviso', assunto: 'Fatura vencida' })).json();
    const c = db.prepare('SELECT * FROM conversas WHERE id = ?').get(r.conversa_id);
    assert.equal(c.estado, 'aguardando', 'aviso automático não vira atendimento da IA');
    assert.equal(c.assunto, 'Fatura vencida');
    assert.ok(c.fila_id, 'já entra numa fila da equipe');
  });

  test('o chamado aberto pela IA é fechado pelo sistema da empresa', async () => {
    const ia = h.fingirIa([{ ferramenta: 'abrir_chamado', entrada: { assunto: 'Visita técnica', descricao: 'Sem sinal desde ontem.', fila: null } }, { texto: 'Chamado aberto!' }]);
    try {
      await h.conversar(db, 'minha internet não liga desde ontem', { telefone: '5511933332222' });
    } finally { ia.restaurar(); }
    const chamado = db.prepare("SELECT * FROM chamados WHERE empresa_id = ? AND aberto_por = 'ia' ORDER BY id DESC LIMIT 1").get(ambiente.empresa.id);
    assert.ok(chamado, 'a IA abriu o chamado');

    const nova = await (await chamar('POST', `/empresas/${ambiente.empresa.id}/chaves`, { nome: 'ERP 3' }, tokens.admin)).json();
    const r = await fetch(`${base}/api/integracao/chamados/${chamado.protocolo}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${nova.chave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolvido', resolucao: 'Fibra rompida trocada.', avisar_cliente: true, aviso: 'Seu chamado foi resolvido: trocamos a fibra rompida.' }),
    });
    assert.equal(r.status, 200);
    const atualizado = await r.json();
    assert.equal(atualizado.status, 'resolvido');
    assert.equal(atualizado.aviso, 'na fila de envio');
  });
});
