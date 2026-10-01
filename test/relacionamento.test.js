'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('Relacionamento com o gerente', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);

  let tkGabi, tkMarcos, tkOper, gabi, marcos, ana, beto, contaAna, contaBeto, tkAna, tkBeto;

  const digitar = async (senha) => {
    const d = (await api.post('/ib/auth/teclado', {}, null)).dados;
    return { teclado_id: d.id, sequencia: [...senha].map((c) => d.teclas.findIndex((par) => par.includes(Number(c)))) };
  };
  async function acessoIb(cliente, documento) {
    const hab = await api.post(`/clientes/${cliente.id}/internet-banking`);
    let tk = (await api.post('/ib/auth/login', { documento, ...(await digitar(hab.dados.senha_provisoria)) }, null)).dados.token;
    await api.req('POST', '/ib/auth/primeiro-acesso', { nova_senha: '730194', pin: '482913' }, tk);
    tk = (await api.post('/ib/auth/login', { documento, ...(await digitar('730194')) }, null)).dados.token;
    return tk;
  }
  const ib = (m, c, b, tk) => api.req(m, `/ib${c}`, b, tk);

  await t.test('conta aberta por gerente fica na carteira dele; troca de gerente exige alçada', async () => {
    gabi = (await api.post('/usuarios', { nome: 'Gabriela Gerente', email: 'gabi@payax.com.br', perfil: 'gerente', senha: 'senha-forte-1' })).dados;
    marcos = (await api.post('/usuarios', { nome: 'Marcos Gerente', email: 'marcos@payax.com.br', perfil: 'gerente', senha: 'senha-forte-1' })).dados;
    await api.post('/usuarios', { nome: 'Otávio Operador', email: 'oper@payax.com.br', perfil: 'operador', senha: 'senha-forte-1' });
    tkGabi = await api.login('gabi@payax.com.br', 'senha-forte-1');
    tkMarcos = await api.login('marcos@payax.com.br', 'senha-forte-1');
    tkOper = await api.login('oper@payax.com.br', 'senha-forte-1');
    ana = (await api.post('/clientes', { tipo: 'PF', nome: 'Ana Souza', documento: '529.982.247-25' })).dados;
    beto = (await api.post('/clientes', { tipo: 'PF', nome: 'Beto Lima', documento: '111.444.777-35' })).dados;
    contaAna = (await api.post('/contas', { cliente_id: ana.id, tipo: 'corrente' }, tkGabi)).dados;
    assert.equal(contaAna.gerente_id, gabi.id);
    assert.equal(contaAna.gerente_nome, 'Gabriela Gerente');
    contaBeto = (await api.post('/contas', { cliente_id: beto.id, tipo: 'corrente' })).dados;
    assert.equal(contaBeto.gerente_id, null);
    assert.equal((await api.patch(`/contas/${contaBeto.id}/gerente`, { gerente_id: marcos.id }, tkOper)).status, 403);
    assert.equal((await api.patch(`/contas/${contaBeto.id}/gerente`, { gerente_id: 9999 })).status, 422);
    const r = await api.patch(`/contas/${contaBeto.id}/gerente`, { gerente_id: marcos.id });
    assert.equal(r.dados.gerente_nome, 'Marcos Gerente');
    const lista = await api.get(`/contas?gerente_id=${gabi.id}`);
    assert.deepEqual(lista.dados.itens.map((c) => c.id), [contaAna.id]);
  });

  await t.test('cliente vê o gerente e manda mensagem pelo Internet Banking', async () => {
    tkAna = await acessoIb(ana, '52998224725');
    const g = await ib('GET', '/gerente', undefined, tkAna);
    assert.deepEqual(g.dados.gerentes.map((x) => x.nome), ['Gabriela Gerente']);
    assert.equal((await ib('POST', '/mensagens', { texto: '   ' }, tkAna)).status, 422);
    assert.equal((await ib('POST', '/mensagens', { texto: 'Olá! Quero aumentar meu limite diário.' }, tkAna)).status, 201);
    assert.equal((await ib('POST', '/mensagens', { texto: 'Oi', gerente_id: marcos.id }, tkAna)).status, 404);
  });

  await t.test('gerente vê só a própria carteira, responde e o cliente lê', async () => {
    const conv = (await api.get('/relacionamento/conversas', tkGabi)).dados;
    assert.equal(conv.length, 1);
    assert.equal(conv[0].nao_lidas, 1);
    assert.equal(conv[0].ultima_autor, 'cliente');
    assert.equal((await api.get('/relacionamento/conversas', tkMarcos)).dados.length, 0);
    assert.equal((await api.get(`/relacionamento/conversas/${ana.id}`, tkMarcos)).status, 403);
    assert.equal((await api.get('/relacionamento/painel', tkOper)).status, 403);
    const c = await api.get(`/relacionamento/conversas/${ana.id}`, tkGabi);
    assert.equal(c.dados.mensagens.length, 1);
    assert.equal((await api.post(`/relacionamento/conversas/${ana.id}`, { texto: 'Olá, Ana! Já ajustei para R$ 15.000.' }, tkGabi)).status, 201);
    assert.equal((await ib('GET', '/gerente', undefined, tkAna)).dados.nao_lidas, 1);
    const minhas = (await ib('GET', '/mensagens', undefined, tkAna)).dados.mensagens;
    assert.deepEqual(minhas.map((m) => m.autor), ['cliente', 'gerente']);
    assert.equal((await ib('GET', '/gerente', undefined, tkAna)).dados.nao_lidas, 0);
  });

  await t.test('gerente inicia contato com cliente da carteira, nunca fora dela', async () => {
    assert.equal((await api.post(`/relacionamento/conversas/${beto.id}`, { texto: 'Olá, Beto!' }, tkGabi)).status, 403);
    assert.equal((await api.post(`/relacionamento/conversas/${beto.id}`, { texto: 'Olá, Beto! Sou o Marcos, seu gerente.' }, tkMarcos)).status, 201);
    const cart = (await api.get('/relacionamento/carteira', tkMarcos)).dados;
    assert.deepEqual(cart.map((c) => c.nome), ['Beto Lima']);
  });

  await t.test('painel do gerente e do administrador', async () => {
    const p = (await api.get('/relacionamento/painel?dias=7', tkGabi)).dados;
    assert.equal(p.carteira_clientes, 1);
    assert.equal(p.clientes_contato, 1);
    assert.equal(p.clientes_contatados, 1);
    assert.equal(p.recebidas, 1);
    assert.equal(p.enviadas, 1);
    assert.equal(p.aguardando, 0);
    assert.equal(typeof p.tempo_medio_resposta_min, 'number');
    assert.equal(p.serie.length, 7);
    assert.equal(p.serie.at(-1).recebidas + p.serie.at(-1).enviadas, 2);
    assert.equal(p.contatos[0].cliente_nome, 'Ana Souza');
    assert.equal(p.contatos[0].iniciado_por, 'cliente');
    const pm = (await api.get('/relacionamento/painel', tkMarcos)).dados;
    assert.equal(pm.clientes_contato, 0);
    assert.equal(pm.clientes_contatados, 1);
    assert.equal(pm.contatos[0].iniciado_por, 'gerente');
    const adm = (await api.get('/relacionamento/painel')).dados;
    assert.equal(adm.recebidas, 1);
    assert.equal(adm.enviadas, 2);
    assert.deepEqual(adm.por_gerente.map((g) => [g.nome, g.carteira_clientes]), [['Gabriela Gerente', 1], ['Marcos Gerente', 1]]);
  });

  await t.test('cliente sem gerente fala com o Atendimento PAY AX (administrador)', async () => {
    const cli = (await api.post('/clientes', { tipo: 'PF', nome: 'Carla Dias', documento: '153.509.460-56' })).dados;
    await api.post('/contas', { cliente_id: cli.id, tipo: 'corrente' });
    tkBeto = await acessoIb(cli, '15350946056');
    assert.deepEqual((await ib('GET', '/gerente', undefined, tkBeto)).dados.gerentes, []);
    assert.equal((await ib('POST', '/mensagens', { texto: 'Quem é meu gerente?' }, tkBeto)).status, 201);
    const conv = (await api.get('/relacionamento/conversas?gerente_id=atendimento')).dados;
    assert.equal(conv[0].cliente_nome, 'Carla Dias');
    assert.equal(conv[0].gerente_id, null);
    assert.equal((await api.post(`/relacionamento/conversas/${cli.id}`, { texto: 'Olá! Vamos indicar seu gerente.', gerente_id: 'atendimento' })).status, 201);
  });
});
