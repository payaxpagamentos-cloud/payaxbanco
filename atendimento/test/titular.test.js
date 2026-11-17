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

test('padrão da plataforma: integração nova e as que já existiam confirmam pelo CPF/CNPJ + nome', () => {
  const { db, empresa } = h.criarAmbiente();
  db.prepare("INSERT INTO ixc_config (empresa_id, ativo, url, atualizado_em) VALUES (?, 0, 'https://x', datetime('now'))").run(empresa.id);
  assert.equal(ixcTools.metodoConfirmacao(db, empresa.id), 'titular_pendente', 'nova: já vem no modo titular');
  // Banco antigo, com a integração no modo dos 3 dígitos: a migração liga uma vez só.
  db.prepare('UPDATE ixc_config SET confirmar_titular = 0 WHERE empresa_id = ?').run(empresa.id);
  db.prepare("DELETE FROM configuracoes WHERE chave = 'migracao_titular'").run();
  const { abrir } = require('../server/db');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-')), 'b.db');
  const a = abrir(arq);
  a.prepare("INSERT INTO empresas (nome, status, criada_em) VALUES ('X', 'ativa', datetime('now'))").run();
  a.prepare("INSERT INTO ixc_config (empresa_id, ativo, url, confirmar_titular, atualizado_em) VALUES (1, 1, 'https://x', 0, datetime('now'))").run();
  a.prepare("DELETE FROM configuracoes WHERE chave = 'migracao_titular'").run();
  a.close();
  const b = abrir(arq);
  assert.equal(b.prepare('SELECT confirmar_titular FROM ixc_config').get().confirmar_titular, 1, 'ligou na atualização');
  b.prepare('UPDATE ixc_config SET confirmar_titular = 0').run();
  b.close();
  assert.equal(abrir(arq).prepare('SELECT confirmar_titular FROM ixc_config').get().confirmar_titular, 0, 'depois respeita a escolha da empresa');
});

describe('boleto do começo ao fim, sem transferir', () => {
  const comFatura = (extra = {}) => ({
    ...h.CADASTRO,
    clientes: h.CADASTRO.clientes.map((c) => ({ ...c, telefone_celular: '(11) 90000-0000' })),
    faturas: h.CADASTRO.faturas.map((f) => ({ ...f, linha_digitavel: '34191790010104351004791020150008291070026000', ...extra })),
  });

  test('CPF → "sim" → 2ª via sai sozinha, em poucas etapas', async () => {
    const meta = h.fingirMeta();
    const ixc = h.fingirIxc(comFatura());
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id, { confirmar_titular: 1 });
    const ia = h.fingirIa([
      { texto: 'Claro! Me passa o CPF ou CNPJ do titular?' },
      { ferramenta: 'identificar_cliente', entrada: { documento: '12345678909' } },
      { texto: 'A conta está em nome de Ana Clara Ribeiro. Está correto?' },
      { ferramenta: 'confirmar_identidade', entrada: { resposta: 'sim correto.' } },
      { ferramenta: 'enviar_segunda_via', entrada: { fatura_id: null } },
      { texto: 'Pronto, Ana! Mandei a 2ª via aqui. Precisa de mais alguma coisa?' },
    ]);
    try {
      await h.conversar(db, 'preciso do boleto para pagar');
      await h.conversar(db, '123.456.789-09');
      await h.conversar(db, 'sim correto.');
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'bot', 'não transferiu');
      assert.equal(c.identidade_confirmada, 1);
      const textos = meta.enviadas.map((m) => m.texto ?? '').join(' ');
      assert.match(textos, /34191790010104351004791020150008291070026000/);
      assert.ok(meta.enviadas.some((m) => m.tipo === 'document'), 'o PDF foi junto');
      assert.match(textos, /mais antiga|vence em 10\/10\/2026/, 'sem id, mandou a fatura mais antiga');
    } finally { ia.restaurar(); ixc.restaurar(); meta.restaurar(); }
  });

  test('o IXC demorou para gerar o PDF: manda a linha digitável mesmo assim, sem transferir', async () => {
    const meta = h.fingirMeta();
    const ixc = h.fingirIxc(comFatura(), { boletoFalha: true });
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id, { confirmar_titular: 1 });
    try {
      const sem = h.semIa(); await h.conversar(db, 'oi'); sem.restaurar();
      const conversa = h.conversaDoCliente(db);
      const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);
      const run = (nome, entrada) => ixcTools.executar(ixcTools.FERRAMENTAS[nome], { db, empresa, conversa: h.conversaDoCliente(db), contato, entrada });
      await run('identificar_cliente', { documento: '12345678909' });
      await run('confirmar_identidade', { resposta: 'sim' });
      const r = await run('enviar_segunda_via', { fatura_id: null });
      assert.equal(r.enviado, true);
      assert.equal(r.com_pdf, false);
      assert.equal(r.com_linha_digitavel, true);
    } finally { ixc.restaurar(); meta.restaurar(); }
  });
});
