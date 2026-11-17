'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const conhecimento = require('../server/ia/conhecimento');

/**
 * Fluxos prontos: o que se repete todo dia sai em código, sem IA. Cada teste confere que a IA
 * NÃO foi chamada (zero token) e que o cliente recebe a resposta certa.
 */
const LINHA = '34191790010104351004791020150008291070026000';
const cadastro = ({ acesso = 'A', online = 'S' } = {}) => ({
  ...h.CADASTRO,
  // Telefone fora do cadastro: o caminho é pelo documento (o padrão da plataforma).
  clientes: h.CADASTRO.clientes.map((c) => ({ ...c, telefone_celular: '(11) 90000-0000' })),
  contratos: h.CADASTRO.contratos.map((c) => ({ ...c, status_internet: acesso })),
  faturas: h.CADASTRO.faturas.map((f) => ({ ...f, linha_digitavel: LINHA })),
  logins: h.CADASTRO.logins.map((l) => ({ ...l, online })),
});

describe('fluxos prontos, sem IA', () => {
  let meta; let ixc; let ia; let db; let empresa;
  const preparar = (dados) => {
    ixc?.restaurar();
    ixc = h.fingirIxc(dados);
  };
  const falar = (texto) => h.conversar(db, texto);
  const saidas = () => meta.enviadas.map((m) => m.texto ?? `[${m.tipo}]`);
  const ultima = () => saidas().at(-1);

  beforeEach(() => {
    meta = h.fingirMeta();
    ({ db, empresa } = h.criarAmbiente());
    h.comIxc(db, empresa.id, { confirmar_titular: 1 });
    // A IA fica "ligada": se algum fluxo cair nela, o teste vê em ia.pedidos.
    ia = h.fingirIa([{ texto: 'resposta da IA' }]);
    ixc = null; // o do teste anterior já foi restaurado
    preparar(cadastro());
  });
  afterEach(() => { ia.restaurar(); ixc.restaurar(); meta.restaurar(); });

  test('2ª via: pede o documento, confirma o titular e manda PIX/linha/PDF', async () => {
    await falar('bom dia, preciso do boleto');
    assert.match(ultima(), /me informa o CPF ou CNPJ do titular/);
    await falar('123.456.789-09');
    assert.equal(ultima(), 'A conta está em nome de Ana Clara Ribeiro. Está correto?');
    await falar('sim');
    assert.ok(saidas().some((t) => t.includes(LINHA)), 'linha digitável');
    assert.ok(meta.enviadas.some((m) => m.tipo === 'document'), 'PDF');
    assert.match(ultima(), /Te mandei a 2ª via/);
    assert.equal(ia.pedidos.length, 0, 'nenhum token de IA');
    assert.equal(h.conversaDoCliente(db).estado, 'bot');
  });

  test('documento já na primeira mensagem vai direto para a confirmação; "não" pede o titular certo', async () => {
    await falar('quero a segunda via, meu cpf é 123.456.789-09');
    assert.match(ultima(), /em nome de Ana Clara Ribeiro/);
    await falar('não, esse não é o meu nome');
    assert.match(ultima(), /CPF ou CNPJ de quem é o titular/);
    await falar('12345678909');
    await falar('isso mesmo');
    assert.match(ultima(), /Te mandei a 2ª via/);
    assert.equal(ia.pedidos.length, 0);
  });

  test('"já paguei" com bloqueio financeiro: desbloqueio de confiança', async () => {
    preparar(cadastro({ acesso: 'CA' }));
    await falar('já paguei e a internet não voltou');
    await falar('12345678909');
    await falar('sim');
    assert.match(ultima(), /liberei o seu acesso/);
    assert.ok(ixc.chamadas.some((c) => c.recurso === 'desbloqueio_confianca'));
    assert.equal(ia.pedidos.length, 0);
  });

  test('reclamou da internet, mas está bloqueado por fatura: manda a 2ª via e NÃO desbloqueia sozinho', async () => {
    preparar(cadastro({ acesso: 'CA' }));
    await falar('minha internet está lenta');
    await falar('12345678909');
    await falar('sim');
    assert.match(ultima(), /bloqueado por fatura em aberto/);
    assert.ok(saidas().some((t) => t.includes(LINHA)));
    assert.ok(!ixc.chamadas.some((c) => c.recurso === 'desbloqueio_confianca'), 'sem "já paguei", não desbloqueia');
    assert.equal(ia.pedidos.length, 0);
  });

  test('internet lenta com o equipamento online: passo a passo e, se continuar, chamado com protocolo', async () => {
    await falar('a internet tá muito lenta');
    await falar('12345678909');
    await falar('sim');
    assert.match(ultima(), /equipamento está conectado/);
    await falar('continua igual');
    assert.match(ultima(), /Protocolo: \*2026110001\*/);
    assert.ok(ixc.chamadas.some((c) => c.recurso === 'su_oss_chamado' && !c.corpo.qtype), 'abriu o chamado no IXC');
    assert.equal(ia.pedidos.length, 0);
  });

  test('equipamento offline: avisa e, se o cliente disser que voltou, encerra o fluxo', async () => {
    preparar(cadastro({ online: 'N' }));
    await falar('estou sem internet');
    await falar('12345678909');
    await falar('sim');
    assert.match(ultima(), /desconectado/);
    await falar('voltou, obrigado');
    assert.match(ultima(), /Que bom/);
    assert.equal(h.conversaDoCliente(db).fluxo, null);
    assert.equal(ia.pedidos.length, 0);
  });

  test('saiu do trilho: depois de duas respostas sem documento, a IA assume', async () => {
    await falar('preciso da fatura');
    await falar('quais planos vocês têm?');
    assert.equal(ia.pedidos.length, 0, 'a primeira fora do trilho ainda pede o documento');
    await falar('e o de 600 mega quanto custa?');
    assert.equal(ia.pedidos.length, 1, 'na segunda, a IA assume');
  });

  test('pergunta que a base responde sai do artigo, sem IA', async () => {
    conhecimento.salvar(db, empresa.id, { titulo: 'Horário de atendimento', resposta: 'Atendemos de segunda a sexta, das 8h às 18h.',
      perguntas: 'que horas vocês abrem\nhorário de atendimento' });
    await falar('que horas vocês abrem?');
    assert.equal(ultima(), 'Atendemos de segunda a sexta, das 8h às 18h.');
    assert.equal(ia.pedidos.length, 0);
  });

  test('fluxos desligados na empresa: a IA conduz como antes', async () => {
    db.prepare('UPDATE ia_config SET fluxos_ativos = 0 WHERE empresa_id = ?').run(empresa.id);
    await falar('preciso do boleto');
    assert.equal(ia.pedidos.length, 1);
  });

  test('texto trocado pela empresa vale no fluxo', async () => {
    db.prepare('UPDATE ia_config SET textos_fluxo = ? WHERE empresa_id = ?')
      .run(JSON.stringify({ pedir_documento: 'Me passa o CPF/CNPJ do titular, por gentileza.' }), empresa.id);
    await falar('preciso do boleto');
    assert.equal(ultima(), 'Me passa o CPF/CNPJ do titular, por gentileza.');
  });
});
