'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const empresasLib = require('../server/lib/empresas');
const permissoes = require('../server/lib/permissoes');

/**
 * Permissões por pessoa, pela HTTP — porque é pela HTTP que alguém tenta entrar onde não deve.
 * Esconder o menu não é permissão: aqui se prova que a rota recusa.
 */
describe('permissões', () => {
  let meta;
  let db;
  let empresa;
  let servidor;
  let base;
  const tokens = {};
  let atendente;

  const chamar = (metodo, caminho, corpo, token) => fetch(`${base}/api${caminho}`, {
    method: metodo,
    headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const entrar = async (email, senha = 'senha12345') => (await (await chamar('POST', '/auth/login', { email, senha })).json());

  before(async () => {
    meta = h.fingirMeta();
    ({ db, empresa } = h.criarAmbiente());
    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;

    atendente = empresasLib.criarUsuario(db, empresa.id, { nome: 'Marina', email: 'marina.p@fibramais.com.br', perfil: 'atendente', senha: 'senha12345' }).usuario;
    empresasLib.criarUsuario(db, empresa.id, { nome: 'Beatriz', email: 'bia.p@fibramais.com.br', perfil: 'supervisor', senha: 'senha12345' });
    // Um contato e uma conversa de verdade: as permissões "dentro da tela" só aparecem com dado.
    const conversas = require('../server/lib/conversas');
    const contato = conversas.garantirContato(db, empresa.id, '5511988887777', 'Ana Souza');
    db.prepare("UPDATE contatos SET documento = '12345678909' WHERE id = ?").run(contato.id);
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
    conversas.abrir(db, { empresa, numero, contato });

    tokens.admin = (await entrar('carlos@fibramais.com.br')).token;
    tokens.atendente = (await entrar('marina.p@fibramais.com.br')).token;
    tokens.supervisor = (await entrar('bia.p@fibramais.com.br')).token;
  });
  after(async () => { meta.restaurar(); await new Promise((r) => servidor.close(r)); });

  test('o login já diz o que a pessoa pode', async () => {
    const admin = await entrar('carlos@fibramais.com.br');
    const at = await entrar('marina.p@fibramais.com.br');
    assert.ok(admin.usuario.permissoes.includes('custos.editar'));
    assert.equal(at.usuario.permissoes.includes('custos.ver'), false, 'atendente não vê o Centro de Custo');
    assert.ok(at.usuario.permissoes.includes('atendimentos.atender'));
  });

  test('a lista de usuários responde e diz quem tem permissão ajustada', async () => {
    const r = await chamar('GET', `/empresas/${empresa.id}/usuarios`, null, tokens.admin);
    assert.equal(r.status, 200);
    const { itens } = await r.json();
    assert.ok(itens.length >= 3);
    const marina = itens.find((u) => u.email === 'marina.p@fibramais.com.br');
    assert.equal(marina.permissoes_ajustadas, false, 'ainda não foi ajustada');
    assert.equal(typeof marina.em_atendimento, 'number');
  });

  test('o atendente não entra no Centro de Custo, nem pela API', async () => {
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/reguas`, null, tokens.atendente)).status, 403);
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/reguas/custos/resumo`, null, tokens.atendente)).status, 403);
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/reguas`, null, tokens.admin)).status, 200);
  });

  test('o supervisor vê e não muda', async () => {
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/reguas/custos/resumo`, null, tokens.supervisor)).status, 200);
    const r = await chamar('PUT', `/empresas/${empresa.id}/reguas/orcamento`, { orcamento_milesimos: 1000 }, tokens.supervisor);
    assert.equal(r.status, 403);
  });

  test('liberar um item para uma pessoa abre a porta, e só para ela', async () => {
    const antes = await chamar('GET', `/empresas/${empresa.id}/reguas/custos/resumo`, null, tokens.atendente);
    assert.equal(antes.status, 403);

    const atuais = [...permissoes.efetivas(db, db.prepare('SELECT * FROM usuarios WHERE id = ?').get(atendente.id))];
    const r = await chamar('PUT', `/empresas/${empresa.id}/usuarios/${atendente.id}/permissoes`,
      { permissoes: [...atuais, 'custos.ver'] }, tokens.admin);
    assert.equal(r.status, 200);

    const depois = await chamar('GET', `/empresas/${empresa.id}/reguas/custos/resumo`, null, tokens.atendente);
    assert.equal(depois.status, 200, 'agora ela entra');
    // A permissão vale na hora, sem precisar sair e entrar de novo: é lida do banco a cada chamada.
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/reguas`, null, tokens.supervisor)).status, 200);

    // Outro atendente qualquer continua de fora.
    empresasLib.criarUsuario(db, empresa.id, { nome: 'Rafael', email: 'rafael.p@fibramais.com.br', perfil: 'atendente', senha: 'senha12345' });
    const outro = (await entrar('rafael.p@fibramais.com.br')).token;
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/reguas/custos/resumo`, null, outro)).status, 403);
  });

  test('tirar um item fecha a porta na mesma hora', async () => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(atendente.id);
    const atuais = [...permissoes.efetivas(db, u)].filter((p) => p !== 'atendimentos.notas');
    await chamar('PUT', `/empresas/${empresa.id}/usuarios/${atendente.id}/permissoes`, { permissoes: atuais }, tokens.admin);

    const conversa = db.prepare('SELECT id FROM conversas LIMIT 1').get();
    const r = await chamar('POST', `/empresas/${empresa.id}/conversas/${conversa.id}/notas`, { texto: 'nota' }, tokens.atendente);
    assert.equal(r.status, 403);
    assert.match((await r.json()).erro, /Escrever notas internas/);
  });

  test('ninguém se tranca do lado de fora nem deixa a empresa sem administrador', async () => {
    const admin = db.prepare("SELECT * FROM usuarios WHERE empresa_id = ? AND perfil = 'cliente' AND ativo = 1").get(empresa.id);
    const r = await chamar('PUT', `/empresas/${empresa.id}/usuarios/${admin.id}/permissoes`,
      { permissoes: ['atendimentos.ver'] }, tokens.admin);
    assert.equal(r.status, 400);
    assert.match((await r.json()).erro, /última pessoa que administra|não pode tirar de si/);
  });

  test('o CPF aparece mascarado para quem não tem permissão de ver', async () => {
    const contato = db.prepare("SELECT id FROM contatos WHERE empresa_id = ? AND documento IS NOT NULL LIMIT 1").get(empresa.id);

    const comoAdmin = await (await chamar('GET', `/empresas/${empresa.id}/contatos`, null, tokens.admin)).json();
    const comoAtendente = await (await chamar('GET', `/empresas/${empresa.id}/contatos`, null, tokens.atendente)).json();
    const doAdmin = comoAdmin.itens.find((c) => c.id === contato.id);
    const doAtendente = comoAtendente.itens.find((c) => c.id === contato.id);

    assert.equal(doAdmin.documento, '12345678909');
    assert.equal(comoAdmin.documento_visivel, true);
    assert.equal(doAtendente.documento, '123••••••09', 'o fim fica visível: dá para conferir sem entregar o documento');
    assert.equal(comoAtendente.documento_visivel, false);
  });

  test('quem vê mascarado não consegue sobrescrever o documento com a máscara', async () => {
    const contato = db.prepare("SELECT id FROM contatos WHERE empresa_id = ? AND documento = '12345678909'").get(empresa.id);
    await chamar('PATCH', `/empresas/${empresa.id}/contatos/${contato.id}`, { documento: '123••••••09' }, tokens.atendente);
    const depois = db.prepare('SELECT documento FROM contatos WHERE id = ?').get(contato.id);
    assert.equal(depois.documento, '12345678909', 'o documento real continua lá');
  });

  test('a ficha 360° pede permissão própria', async () => {
    const contato = db.prepare('SELECT id FROM contatos WHERE empresa_id = ? LIMIT 1').get(empresa.id);
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/contatos/${contato.id}/ficha`, null, tokens.atendente)).status, 403);
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/contatos/${contato.id}/ficha`, null, tokens.admin)).status, 200);
  });

  test('as permissões da equipe da plataforma não se mexem pelo painel da empresa', async () => {
    const master = db.prepare("SELECT id FROM usuarios WHERE perfil = 'master'").get();
    const r = await chamar('PUT', `/empresas/${empresa.id}/usuarios/${master.id}/permissoes`, { permissoes: [] }, tokens.admin);
    assert.equal(r.status, 404, 'o master não é da empresa, então nem aparece por aqui');
  });

  test('o master tem tudo, sempre', () => {
    const master = db.prepare("SELECT * FROM usuarios WHERE perfil = 'master'").get();
    permissoes.definir(db, master.id, 'master', []);
    assert.equal(permissoes.efetivas(db, master).size, permissoes.TODAS.length, 'nem revogando à mão ele perde');
  });

  test('o ajuste guarda a diferença, não a lista inteira', () => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(atendente.id);
    const padrao = permissoes.doPerfil('atendente');
    const linhas = db.prepare('SELECT permissao, concedida FROM usuario_permissoes WHERE usuario_id = ?').all(u.id);
    for (const l of linhas) {
      assert.notEqual(padrao.has(l.permissao), Boolean(l.concedida),
        `${l.permissao} está gravada mas é igual ao padrão do perfil: a diferença é que deve ser guardada`);
    }
  });
});
