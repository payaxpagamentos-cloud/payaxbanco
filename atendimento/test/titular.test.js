'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const h = require('./helpers');
const ixcTools = require('../server/ia/ferramentas-ixc');
const { criarApp } = require('../server/app');

/**
 * Modo "só o CPF/CNPJ": o cliente informa o documento, a ZOE diz em nome de quem está a conta e
 * pergunta se está correto. Com o "sim", segue. Sem data de nascimento (empresa nem tem).
 */
describe('confirmar pelo nome do titular', () => {
  let meta; let ixc; let ambiente;
  const ferramenta = (nome, entrada) => {
    const { db, empresa } = ambiente;
    const conversa = h.conversaDoCliente(db);
    const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);
    return ixcTools.executar(ixcTools.FERRAMENTAS[nome], { db, empresa, conversa, contato, entrada });
  };

  beforeEach(async () => {
    meta = h.fingirMeta();
    // Telefone que NÃO está no cadastro do IXC: o caminho é pelo documento.
    ixc = h.fingirIxc({ ...h.CADASTRO, clientes: h.CADASTRO.clientes.map((c) => ({ ...c, telefone_celular: '(11) 90000-0000' })) });
    ambiente = h.criarAmbiente();
    h.comIxc(ambiente.db, ambiente.empresa.id);
    ambiente.db.prepare('UPDATE ixc_config SET confirmar_titular = 1 WHERE empresa_id = ?').run(ambiente.empresa.id);
    const sem = h.semIa();
    await h.conversar(ambiente.db, 'oi');
    sem.restaurar();
  });
  afterEach(() => { meta.restaurar(); ixc.restaurar(); });

  test('CPF informado → "a conta está em nome de…" → "sim" libera as consultas', async () => {
    const id = await ferramenta('identificar_cliente', { documento: '123.456.789-09' });
    assert.equal(id.titular, 'Ana Clara Ribeiro');
    assert.match(id.instrucao, /A conta está em nome de Ana Clara Ribeiro\. Está correto\?/);
    assert.doesNotMatch(id.instrucao, /nascimento/i, 'não pede data de nascimento');

    const antes = await ferramenta('faturas_em_aberto', {});
    assert.equal(antes.ok, false, 'antes do sim, nada do contrato');

    const ok = await ferramenta('confirmar_identidade', { resposta: 'sim, isso mesmo' });
    assert.equal(ok.confere, true);
    const faturas = await ferramenta('faturas_em_aberto', {});
    assert.equal(faturas.ok, true);
  });

  test('"não" não libera, esquece o cadastro e pede o documento certo; o limite vale', async () => {
    await ferramenta('identificar_cliente', { documento: '12345678909' });
    const nao = await ferramenta('confirmar_identidade', { resposta: 'não, esse não é meu nome' });
    assert.equal(nao.ok, false);
    assert.match(nao.instrucao, /CPF ou CNPJ/);
    const c = h.conversaDoCliente(ambiente.db);
    assert.equal(c.ixc_cliente_id, null);
    assert.equal(c.identidade_confirmada, 0);

    // Três tentativas (o padrão): depois disso, nem consulta outro documento — cada consulta revelaria um nome.
    await ferramenta('identificar_cliente', { documento: '12345678909' });
    await ferramenta('confirmar_identidade', { resposta: 'não' });
    await ferramenta('identificar_cliente', { documento: '12345678909' });
    await ferramenta('confirmar_identidade', { resposta: 'nao' });
    const bloqueado = await ferramenta('identificar_cliente', { documento: '12345678909' });
    assert.equal(bloqueado.bloqueado, 'limite de tentativas');
  });

  test('reconhecido pelo telefone, ainda assim pede o CPF/CNPJ antes do nome', async () => {
    ixc.restaurar();
    ixc = h.fingirIxc(h.CADASTRO); // agora o telefone está no cadastro
    const { db } = ambiente;
    const conversa = h.conversaDoCliente(db);
    const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);
    assert.equal(await ixcTools.identificarPeloTelefone(db, { conversa, contato }), null, 'não pré-identifica pelo telefone');
    assert.equal(h.conversaDoCliente(db).ixc_cliente_id, null);
    const pulou = await ferramenta('confirmar_identidade', { resposta: 'sim' });
    assert.equal(pulou.ok, false, 'sem o documento, o "sim" não vale');
    assert.match(ixcTools.notaDeEstado(db, h.conversaDoCliente(db)), /peça o CPF ou CNPJ/);
  });
});

test('a tela salva e mostra o modo "só o CPF/CNPJ"', async () => {
  const meta = h.fingirMeta();
  const { db, empresa } = h.criarAmbiente();
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/api`;
    const { token } = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'carlos@fibramais.com.br', senha: 'senha12345' }) })).json();
    const chamar = (m, corpo) => fetch(`${base}/empresas/${empresa.id}/ixc`, { method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: corpo ? JSON.stringify(corpo) : undefined });
    assert.equal((await chamar('PATCH', { confirmar_por: 'titular' })).status, 200);
    assert.equal((await (await chamar('GET')).json()).confirmar_por, 'titular');
    assert.equal(ixcTools.metodoConfirmacao(db, empresa.id), 'titular_pendente');
    assert.equal((await chamar('PATCH', { confirmar_por: 'cpf3' })).status, 200);
    assert.equal((await (await chamar('GET')).json()).confirmar_por, 'cpf3');
  } finally { meta.restaurar(); await new Promise((r) => servidor.close(r)); }
  void http;
});
