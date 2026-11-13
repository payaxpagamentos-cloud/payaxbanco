'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const empresasLib = require('../server/lib/empresas');
const voz = require('../server/lib/voz');

/**
 * A ZOE ao telefone, pela HTTP, do jeito que a central telefônica chama.
 * O que se prova aqui é que é a MESMA ZOE do WhatsApp: mesmas regras, mesmo portão de
 * identidade, mesma Ouvidoria — e que nada da ligação escapa para o WhatsApp ou para a Meta.
 */
describe('ligação atendida pela ZOE', () => {
  let meta;
  let db;
  let empresa;
  let servidor;
  let base;
  let chave;

  const chamar = async (caminho, corpo) => {
    const r = await fetch(`${base}/api/integracao${caminho}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': chave }, body: JSON.stringify(corpo ?? {}),
    });
    return { status: r.status, dados: await r.json() };
  };

  before(async () => {
    meta = h.fingirMeta();
    ({ db, empresa } = h.criarAmbiente());
    chave = empresasLib.criarChaveApi(db, empresa.id, 'Asterisk').chave;
    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(async () => { meta.restaurar(); await new Promise((r) => servidor.close(r)); });

  test('a ZOE atende falando a saudação da empresa', async () => {
    const r = await chamar('/voz/ligacoes', { uid: '1700000001.1', telefone: '11977776666' });
    assert.equal(r.status, 201);
    assert.equal(r.dados.acao, 'ouvir');
    assert.ok(r.dados.fala.length > 5, 'saudação falada');
    const c = db.prepare('SELECT * FROM conversas WHERE id = ?').get(r.dados.conversa_id);
    assert.equal(c.canal, 'telefone');
    assert.equal(c.janela_expira_em, null, 'ligação não tem janela de 24 h: a Meta não está no meio');
    const contato = db.prepare('SELECT telefone FROM contatos WHERE id = ?').get(c.contato_id);
    assert.equal(contato.telefone, '5511977776666', 'a Bina vira o mesmo telefone do WhatsApp: é a mesma pessoa');
  });

  test('a central repetir o início não abre outra conversa', async () => {
    const r = await chamar('/voz/ligacoes', { uid: '1700000001.1', telefone: '11977776666' });
    assert.equal(r.status, 200);
    assert.equal(r.dados.repetida, true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM conversas WHERE ligacao_uid = '1700000001.1'").get().n, 1);
  });

  test('nada da ligação vai para o WhatsApp nem custa na Meta', async () => {
    const antes = meta.enviadas.length;
    const sem = h.semIa();
    try { await chamar('/voz/ligacoes/1700000001.1/turno', { texto: 'qual o horário de atendimento' }); } finally { sem.restaurar(); }
    await require('../server/lib/envio').processarFila(db);
    assert.equal(meta.enviadas.length, antes, 'nenhuma mensagem saiu pela Graph API');
    const c = db.prepare("SELECT id FROM conversas WHERE ligacao_uid = '1700000001.1'").get();
    const saidas = db.prepare("SELECT status, categoria, custo_milesimos FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND autor = 'ia'").all(c.id);
    assert.ok(saidas.length >= 2);
    assert.ok(saidas.every((m) => m.status === 'falada' && m.categoria === null && m.custo_milesimos === 0));
  });

  test('pedir atendente em voz alta transfere, com a fila para a central', async () => {
    await chamar('/voz/ligacoes', { uid: '1700000002.1', telefone: '11966665555' });
    const sem = h.semIa();
    let r;
    try {
      const antes = await chamar('/voz/ligacoes/1700000002.1/turno', { texto: 'quero falar com um atendente' });
      assert.equal(antes.dados.acao, 'ouvir', 'primeiro a ZOE pergunta o assunto, uma vez');
      assert.match(antes.dados.fala, /me diz em poucas palavras/);
      r = await chamar('/voz/ligacoes/1700000002.1/turno', { texto: 'quero um atendente' });
    } finally { sem.restaurar(); }
    assert.equal(r.dados.acao, 'transferir', 'pediu de novo: transfere');
    assert.ok(r.dados.fila?.nome, 'a central usa o nome para escolher a fila de ramais');
    assert.ok(r.dados.fala, 'avisa antes de transferir');
    const c = db.prepare("SELECT * FROM conversas WHERE ligacao_uid = '1700000002.1'").get();
    assert.equal(c.estado, 'aguardando', 'não foi entregue a um atendente do WhatsApp: quem atende é a fila do telefone');
    assert.equal(c.atendente_id, null);
  });

  test('pedir cancelamento ao telefone abre a Ouvidoria, igual ao WhatsApp', async () => {
    await chamar('/voz/ligacoes', { uid: '1700000003.1', telefone: '11955554444' });
    const sem = h.semIa();
    let r;
    try { r = await chamar('/voz/ligacoes/1700000003.1/turno', { texto: 'eu quero cancelar a minha internet' }); } finally { sem.restaurar(); }
    const c = db.prepare("SELECT * FROM conversas WHERE ligacao_uid = '1700000003.1'").get();
    const caso = db.prepare('SELECT * FROM ouvidoria WHERE conversa_id = ?').get(c.id);
    assert.ok(caso, 'caso aberto na Ouvidoria');
    assert.equal(caso.tipo, 'cancelamento');
    assert.match(r.dados.fala, /protocolo/i, 'o protocolo é falado ao cliente');
  });

  test('três falas que não deu para entender passam para uma pessoa', async () => {
    await chamar('/voz/ligacoes', { uid: '1700000004.1', telefone: '11944443333' });
    const r1 = await chamar('/voz/ligacoes/1700000004.1/turno', { texto: '' });
    assert.equal(r1.dados.acao, 'ouvir');
    assert.match(r1.dados.fala, /não consegui entender/);
    await chamar('/voz/ligacoes/1700000004.1/turno', { texto: '' });
    const r3 = await chamar('/voz/ligacoes/1700000004.1/turno', { texto: '' });
    assert.equal(r3.dados.acao, 'transferir', 'ninguém aguenta "pode repetir?" pela quarta vez');
  });

  test('o mesmo turno repetido pela central não é respondido duas vezes', async () => {
    await chamar('/voz/ligacoes', { uid: '1700000005.1', telefone: '11933332222' });
    const sem = h.semIa();
    try {
      await chamar('/voz/ligacoes/1700000005.1/turno', { texto: 'qual o horário', turno_id: 't1' });
      await chamar('/voz/ligacoes/1700000005.1/turno', { texto: 'qual o horário', turno_id: 't1' });
    } finally { sem.restaurar(); }
    const c = db.prepare("SELECT id FROM conversas WHERE ligacao_uid = '1700000005.1'").get();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM mensagens WHERE conversa_id = ? AND direcao = 'entrada'").get(c.id).n, 1);
  });

  test('desligar encerra a conversa no histórico do cliente', async () => {
    const r = await chamar('/voz/ligacoes/1700000005.1/fim');
    assert.equal(r.dados.ok, true);
    const c = db.prepare("SELECT * FROM conversas WHERE ligacao_uid = '1700000005.1'").get();
    assert.equal(c.estado, 'encerrada');
    assert.ok(['ia', 'abandono'].includes(c.resolvida_por));
    // Transferida e desligada antes de algum ramal atender: abandono na fila, não "resolvida por pessoa".
    const transferida = await chamar('/voz/ligacoes/1700000002.1/fim');
    assert.equal(transferida.dados.resolvida_por, 'abandono');
  });

  test('o administrador escolhe teclas e escreve o menu pela configuração da ZOE', async () => {
    const login = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'carlos@fibramais.com.br', senha: 'senha12345' }) })).json();
    const patch = (corpo) => fetch(`${base}/api/empresas/${empresa.id}/ia`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify(corpo),
    });
    const ok = await patch({ voz_modo: 'teclas', voz_menu: [{ tecla: '1', rotulo: 'boleto', pedido: 'Quero o boleto.' }, { tecla: '0', rotulo: 'atendente', pedido: 'Quero um atendente.' }] });
    assert.equal(ok.status, 200);
    const cfg = await ok.json();
    assert.equal(cfg.voz_modo, 'teclas');
    assert.deepEqual(cfg.voz_menu.map((o) => o.tecla), ['1', '0']);

    const repetida = await patch({ voz_menu: [{ tecla: '1', rotulo: 'a', pedido: 'a' }, { tecla: '1', rotulo: 'b', pedido: 'b' }] });
    assert.equal(repetida.status, 422);
    assert.match((await repetida.json()).erro, /aparece duas vezes/);
    const asterisco = await patch({ voz_menu: [{ tecla: '*', rotulo: 'a', pedido: 'a' }] });
    assert.equal(asterisco.status, 422, 'o asterisco é reservado: repete o menu');

    // Volta ao normal para os outros testes desta descrição.
    await patch({ voz_modo: 'fala', voz_menu: null });
  });

  test('ligação de outra empresa não aparece', async () => {
    const outra = empresasLib.criar(db, { nome: 'Outra' }, { comExemplos: false });
    const chaveOutra = empresasLib.criarChaveApi(db, outra.id, 'X').chave;
    const r = await fetch(`${base}/api/integracao/voz/ligacoes/1700000001.1/turno`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': chaveOutra }, body: JSON.stringify({ texto: 'oi' }),
    });
    assert.equal(r.status, 404);
  });
});

describe('a ZOE fala diferente ao telefone', () => {
  let ambiente;
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); ambiente = h.criarAmbiente(); });
  afterEach(() => meta.restaurar());

  test('a IA recebe a instrução de que está numa ligação', async () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'L1', telefone: '11922221111' });
    const iaFalsa = h.fingirIa([{ texto: 'Claro, posso te ajudar com isso.' }]);
    let r;
    try { r = await voz.turno(db, empresa, 'L1', { texto: 'minha internet está lenta' }); } finally { iaFalsa.restaurar(); }
    const notas = iaFalsa.pedidos[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join(' ');
    assert.match(notas, /LIGAÇÃO TELEFÔNICA/);
    assert.match(notas, /Nada de listas, links, emojis/);
    assert.equal(r.fala, 'Claro, posso te ajudar com isso.');
  });

  test('o que ele escreveu no WhatsApp há pouco chega à ZOE do telefone', async () => {
    const { db, empresa } = ambiente;
    // O cliente falou pelo WhatsApp…
    const sem = h.semIa();
    try { await h.conversar(db, 'minha internet caiu e já reiniciei o roteador duas vezes'); } finally { sem.restaurar(); }
    // …e depois ligou do mesmo número.
    voz.iniciar(db, empresa, { uid: 'L2', telefone: h.TELEFONE_CLIENTE.slice(2) });
    const iaFalsa = h.fingirIa([{ texto: 'Vi que você já reiniciou o roteador. Vou verificar a sua conexão.' }]);
    try { await voz.turno(db, empresa, 'L2', { texto: 'alô, continuo sem internet' }); } finally { iaFalsa.restaurar(); }
    const notas = iaFalsa.pedidos[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join(' ');
    assert.match(notas, /conversou pelo WhatsApp nas últimas 24 horas/);
    assert.match(notas, /reiniciei o roteador duas vezes/, 'ninguém deveria ter de explicar tudo de novo no telefone');
  });

  test('a conversa do telefone não vira destino da régua nem da carona', () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'L3', telefone: '11911110000' });
    const contato = db.prepare("SELECT id FROM contatos WHERE telefone = '5511911110000'").get();
    const conversas = require('../server/lib/conversas');
    assert.equal(conversas.abertaDoContato(db, contato.id), undefined, 'aberta no WhatsApp: nenhuma');
    assert.ok(conversas.abertaDoContato(db, contato.id, { canal: 'telefone' }), 'aberta no telefone: a ligação');
  });

  test('a falha do cérebro no meio da ligação não deixa a pessoa no silêncio', async () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'L4', telefone: '11900009999' });
    const iaFalsa = h.fingirIa([{ erro: Object.assign(new Error('caiu'), { status: 500 }) }]);
    let r;
    try { r = await voz.turno(db, empresa, 'L4', { texto: 'minha internet está lenta' }); } finally { iaFalsa.restaurar(); }
    assert.equal(r.acao, 'transferir');
  });
});

describe('segunda via pedida ao telefone', () => {
  let meta;
  let ixc;
  let ambiente;
  const ixcTools = require('../server/ia/ferramentas-ixc');

  beforeEach(() => {
    meta = h.fingirMeta();
    ixc = h.fingirIxc(h.CADASTRO);
    ambiente = h.criarAmbiente();
    h.comIxc(ambiente.db, ambiente.empresa.id);
  });
  afterEach(() => { meta.restaurar(); ixc.restaurar(); });

  /** Uma ligação do cliente do cadastro, com a identidade já confirmada. */
  const ligacaoConfirmada = async () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'SV1', telefone: h.TELEFONE_CLIENTE.slice(2) });
    const conversa = db.prepare("SELECT * FROM conversas WHERE ligacao_uid = 'SV1'").get();
    const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);
    await ixcTools.identificarPeloTelefone(db, { conversa, contato });
    await ixcTools.executar(ixcTools.FERRAMENTAS.confirmar_identidade, { db, empresa, conversa, contato, entrada: { resposta: '123' } });
    return { db, empresa, conversa: db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id), contato };
  };

  test('sem WhatsApp aberto, o IXC manda por SMS e e-mail — e nada é falado de PIX', async () => {
    const ctx = await ligacaoConfirmada();
    const r = await ixcTools.executar(ixcTools.FERRAMENTAS.enviar_segunda_via, { ...ctx, entrada: { fatura_id: '9001' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.enviado_por, ['SMS', 'e-mail']);
    assert.match(r.valor.replace(/\u00a0/g, ' '), /R\$ 129,90/, 'o valor volta para a ZOE falar');
    const pedidos = ixc.chamadas.filter((c) => c.recurso === 'get_boleto').map((c) => c.corpo.tipo_boleto);
    assert.deepEqual(pedidos, ['sms', 'mail'], 'quem envia é o próprio IXC, sem custo de Meta');
    const daLigacao = ctx.db.prepare("SELECT texto FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND texto LIKE '%PIX%'").all(ctx.conversa.id);
    assert.equal(daLigacao.length, 0, 'PIX copia-e-cola não se fala ao telefone');
  });

  test('com o WhatsApp dele aberto, vai por lá — de graça', async () => {
    const { db } = ambiente;
    const sem = h.semIa();
    try { await h.conversar(db, 'oi'); } finally { sem.restaurar(); }
    const ctx = await ligacaoConfirmada();
    const r = await ixcTools.executar(ixcTools.FERRAMENTAS.enviar_segunda_via, { ...ctx, entrada: { fatura_id: '9001' } });
    assert.deepEqual(r.enviado_por, ['WhatsApp']);
    await require('../server/lib/envio').processarFila(db);
    const enviada = meta.enviadas.find((m) => /Segunda via/.test(m.texto ?? ''));
    assert.ok(enviada, 'saiu pelo WhatsApp');
    assert.match(enviada.texto, /34191790010104351004791020150008291070026000/);
    const m = db.prepare("SELECT categoria, custo_milesimos FROM mensagens WHERE texto LIKE 'Segunda via%'").get();
    assert.equal(m.categoria, 'servico');
    assert.equal(m.custo_milesimos, 0, 'dentro da janela de 24 h é serviço: grátis');
  });
});

describe('ligação por teclas', () => {
  let ambiente;
  let meta;
  beforeEach(() => {
    meta = h.fingirMeta();
    ambiente = h.criarAmbiente();
    ambiente.db.prepare("UPDATE ia_config SET voz_modo = 'teclas' WHERE empresa_id = ?").run(ambiente.empresa.id);
  });
  afterEach(() => meta.restaurar());

  test('a ZOE atende com o menu numerado e pede uma tecla só', () => {
    const { db, empresa } = ambiente;
    const r = voz.iniciar(db, empresa, { uid: 'T1', telefone: '11977770001' });
    assert.match(r.fala, /Digite 1 para segunda via da fatura, 2 para liberar o acesso, 3 para problema na internet ou 0 para falar com um atendente/);
    assert.match(r.fala, /asterisco/);
    assert.equal(r.aguardar, 'digitos');
    assert.equal(r.max_digitos, 1, 'esperar 14 dígitos para quem só aperta "1" deixaria a pessoa esperando');
    assert.doesNotMatch(r.fala, /me conta|como posso ajudar/i, 'não pede o que o cliente não tem como fazer por teclas');
  });

  test('a tecla vira o pedido e passa pelo mesmo cérebro', async () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'T2', telefone: '11977770002' });
    const sem = h.semIa();
    let r;
    try { r = await voz.turno(db, empresa, 'T2', { digitos: '0' }); } finally { sem.restaurar(); }
    assert.equal(r.acao, 'transferir', '0 = "quero falar com um atendente", e a regra de pedido de humano vale igual');
    const c = db.prepare("SELECT id FROM conversas WHERE ligacao_uid = 'T2'").get();
    const msgs = db.prepare('SELECT direcao, tipo, texto FROM mensagens WHERE conversa_id = ? ORDER BY id').all(c.id);
    assert.ok(msgs.some((m) => m.direcao === 'entrada' && m.texto === 'Quero falar com um atendente.'));
    assert.ok(msgs.some((m) => m.tipo === 'sistema' && /digitou 0 \(falar com um atendente\)/.test(m.texto)), 'o atendente vê qual tecla foi');
  });

  test('a IA sabe que o cliente só tem o teclado', async () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'T3', telefone: '11977770003' });
    const iaFalsa = h.fingirIa([{ texto: 'Para sua segurança, digite os três primeiros números do CPF do titular.' }]);
    let r;
    try { r = await voz.turno(db, empresa, 'T3', { digitos: '1' }); } finally { iaFalsa.restaurar(); }
    const notas = iaFalsa.pedidos[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join(' ');
    assert.match(notas, /responde SÓ pelo teclado/);
    assert.doesNotMatch(notas, /chega transcrita/, 'por teclas não há fala para transcrever');
    assert.equal(r.max_digitos, 3, 'pediu os três primeiros do CPF: espera três teclas');
  });

  test('depois de escolher no menu, os números vão para a ZOE como resposta', async () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'T4', telefone: '11977770004' });
    const iaFalsa = h.fingirIa([
      { texto: 'Digite os três primeiros números do CPF.' },
      { texto: 'Obrigada, confirmei.' },
    ]);
    try {
      await voz.turno(db, empresa, 'T4', { digitos: '1' });
      await voz.turno(db, empresa, 'T4', { digitos: '123#' });
    } finally { iaFalsa.restaurar(); }
    const c = db.prepare("SELECT id FROM conversas WHERE ligacao_uid = 'T4'").get();
    const entradas = db.prepare("SELECT texto FROM mensagens WHERE conversa_id = ? AND direcao = 'entrada' ORDER BY id").all(c.id).map((m) => m.texto);
    assert.deepEqual(entradas, ['Quero a segunda via da minha fatura.', '123'], 'o "123" não foi lido como opção 1 do menu, e o # sai');
  });

  test('tecla que não existe repete as opções; na terceira, chama uma pessoa', async () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'T5', telefone: '11977770005' });
    const r1 = await voz.turno(db, empresa, 'T5', { digitos: '7' });
    assert.match(r1.fala, /Não recebi uma opção válida\. Digite 1 para/);
    assert.equal(r1.max_digitos, 1);
    await voz.turno(db, empresa, 'T5', { digitos: '' });
    const r3 = await voz.turno(db, empresa, 'T5', { digitos: '8' });
    assert.equal(r3.acao, 'transferir');
  });

  test('asterisco repete o menu a qualquer momento', async () => {
    const { db, empresa } = ambiente;
    voz.iniciar(db, empresa, { uid: 'T6', telefone: '11977770006' });
    const iaFalsa = h.fingirIa([{ texto: 'Digite os três primeiros números do CPF.' }]);
    try { await voz.turno(db, empresa, 'T6', { digitos: '1' }); } finally { iaFalsa.restaurar(); }
    const r = await voz.turno(db, empresa, 'T6', { digitos: '*' });
    assert.match(r.fala, /^Digite 1 para segunda via/);
    assert.equal(r.max_digitos, 1, 'de volta ao menu: a próxima tecla é uma opção');
  });

  test('o menu escrito pela empresa substitui o padrão', () => {
    const { db, empresa } = ambiente;
    db.prepare('UPDATE ia_config SET voz_menu = ? WHERE empresa_id = ?').run(JSON.stringify([
      { tecla: '1', rotulo: 'financeiro', pedido: 'Quero falar sobre pagamento.' },
      { tecla: '9', rotulo: 'ouvir as novidades', pedido: 'Quero saber dos planos novos.' },
    ]), empresa.id);
    const r = voz.iniciar(db, empresa, { uid: 'T7', telefone: '11977770007' });
    assert.match(r.fala, /Digite 1 para financeiro ou 9 para ouvir as novidades/);
  });

  test('menu de botões das regras vira "digite 1 para…", na ordem das filas', () => {
    const payload = { interactive: { action: { buttons: [{ reply: { title: 'Suporte' } }, { reply: { title: 'Financeiro' } }] } } };
    assert.equal(voz.paraFala({ tipo: 'botao', texto: 'Com qual time?', payload }, { teclas: true }), 'Com qual time? Digite 1 para Suporte ou 2 para Financeiro.');
  });

  test('o modo fala continua esperando fala', () => {
    const { db, empresa } = ambiente;
    db.prepare("UPDATE ia_config SET voz_modo = 'fala' WHERE empresa_id = ?").run(empresa.id);
    const r = voz.iniciar(db, empresa, { uid: 'T8', telefone: '11977770008' });
    assert.equal(r.aguardar, 'fala');
    assert.doesNotMatch(r.fala, /Digite 1/);
  });
});

describe('quantas teclas esperar', () => {
  test('pelo que a ZOE pediu', () => {
    assert.equal(voz.quantasTeclas('Digite os três primeiros números do CPF.'), 3);
    assert.equal(voz.quantasTeclas('Digite a data de nascimento do titular, com oito dígitos.'), 8);
    assert.equal(voz.quantasTeclas('Digite o CPF do titular e depois a tecla jogo da velha.'), 14);
    assert.equal(voz.quantasTeclas('Digite 1 para sim ou 2 para não.'), 1);
  });
});

describe('o que vira voz', () => {
  test('tira formatação, emoji e link', () => {
    assert.equal(voz.paraFala({ tipo: 'texto', texto: '*Pronto!* 🎉 Acesse https://exemplo.com/fatura\npara ver.' }), 'Pronto! Acesse. para ver.');
  });
  test('menu de botões vira opções faladas', () => {
    const payload = { interactive: { body: { text: 'Com qual time?' }, action: { buttons: [
      { reply: { title: 'Suporte' } }, { reply: { title: 'Financeiro' } }, { reply: { title: 'Comercial' } }] } } };
    assert.equal(voz.paraFala({ tipo: 'botao', texto: 'Com qual time?', payload }), 'Com qual time? Você pode dizer: Suporte, Financeiro ou Comercial.');
  });
  test('a Bina vira o telefone dos contatos', () => {
    assert.equal(voz.telefoneDaBina('11988887777', 'x'), '5511988887777');
    assert.equal(voz.telefoneDaBina('011988887777', 'x'), '5511988887777');
    assert.equal(voz.telefoneDaBina('+5511988887777', 'x'), '5511988887777');
    assert.match(voz.telefoneDaBina('', '1700.5'), /^anon/, 'número oculto ainda é atendido');
  });
});
