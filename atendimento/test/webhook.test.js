'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
const { criarApp } = require('../server/app');

/** O webhook é a porta de entrada pública da plataforma: só passa evento assinado pela Meta. */
describe('webhook da Meta', () => {
  let meta;
  let ambiente;
  let servidor;
  let base;

  beforeEach(async () => {
    meta = h.fingirMeta();
    ambiente = h.criarAmbiente();
    servidor = criarApp(ambiente.db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });
  afterEach(async () => {
    meta.restaurar();
    await new Promise((r) => servidor.close(r));
  });

  const enviar = (corpo, { assinatura, segredo = h.APP_SECRET } = {}) => {
    const cru = JSON.stringify(corpo);
    return fetch(`${base}/api/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': assinatura ?? `sha256=${crypto.createHmac('sha256', segredo).update(cru).digest('hex')}`,
      },
      body: cru,
    });
  };

  test('a verificação do endereço devolve o desafio só com o token certo', async () => {
    const q = (token) => `${base}/api/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=desafio-123`;
    const certo = await fetch(q(ambiente.numero.verify_token));
    assert.equal(certo.status, 200);
    assert.equal(await certo.text(), 'desafio-123');

    const errado = await fetch(q('token-errado'));
    assert.equal(errado.status, 403);
    assert.match(ambiente.db.prepare('SELECT motivo FROM acessos_recusados ORDER BY id DESC LIMIT 1').get().motivo, /token de verificação/);
  });

  test('recusa evento sem assinatura, com assinatura errada ou de outro segredo', async () => {
    const corpo = h.corpoWebhook(h.mensagemTexto('oi'));
    const cru = JSON.stringify(corpo);

    const sem = await fetch(`${base}/api/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cru });
    assert.equal(sem.status, 401);

    assert.equal((await enviar(corpo, { assinatura: 'sha256=0000' })).status, 401);
    assert.equal((await enviar(corpo, { segredo: 'outro-segredo' })).status, 401);
    assert.equal(Number(ambiente.db.prepare('SELECT COUNT(*) AS n FROM mensagens').get().n), 0, 'nada foi gravado');
  });

  test('aceita o evento assinado e grava a conversa', async () => {
    const r = await enviar(h.corpoWebhook(h.mensagemTexto('bom dia, qual o horário de vocês?', 'wamid.a1')));
    assert.equal(r.status, 200);
    // O 200 vai antes de a atendente pensar; espera o processamento terminar.
    await new Promise((res) => { setTimeout(res, 300); });
    const c = h.conversaDoCliente(ambiente.db);
    assert.ok(c, 'a conversa foi aberta');
    assert.equal(ambiente.db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE direcao = 'entrada'").get().n, 1);
  });

  test('o mesmo evento reenviado não vira duas mensagens', async () => {
    const corpo = h.corpoWebhook(h.mensagemTexto('mensagem única', 'wamid.repetida'));
    await enviar(corpo);
    await enviar(corpo);
    await enviar(corpo);
    await new Promise((res) => { setTimeout(res, 300); });
    assert.equal(Number(ambiente.db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE wa_id = 'wamid.repetida'").get().n), 1);
  });

  test('evento de número não cadastrado é ignorado com 200 (a Meta para de reenviar)', async () => {
    const r = await enviar(h.corpoWebhook(h.mensagemTexto('oi'), { phoneId: '999999999999999' }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, ignorado: 'número não cadastrado' });
  });

  test('número sem App secret cadastrado recusa todo evento', async () => {
    ambiente.db.prepare('UPDATE numeros SET app_secret_cifrado = NULL WHERE id = ?').run(ambiente.numero.id);
    const r = await enviar(h.corpoWebhook(h.mensagemTexto('oi')));
    assert.equal(r.status, 401);
    assert.match(ambiente.db.prepare('SELECT motivo FROM acessos_recusados ORDER BY id DESC LIMIT 1').get().motivo, /sem segredo do app/);
  });

  test('empresa bloqueada não recebe mais mensagem', async () => {
    ambiente.db.prepare("UPDATE empresas SET status = 'bloqueada' WHERE id = ?").run(ambiente.empresa.id);
    const r = await enviar(h.corpoWebhook(h.mensagemTexto('oi')));
    assert.deepEqual(await r.json(), { ok: true, ignorado: 'número não cadastrado' });
    assert.equal(Number(ambiente.db.prepare('SELECT COUNT(*) AS n FROM conversas').get().n), 0);
  });
});

describe('avisos de entrega', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('entregue e lida avançam o status, e um evento fora de ordem não volta atrás', async () => {
    const { db } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const saida = db.prepare("SELECT * FROM mensagens WHERE direcao = 'saida' AND wa_id IS NOT NULL ORDER BY id LIMIT 1").get();
      assert.ok(saida, 'a saudação saiu e tem wa_id');
      assert.equal(saida.status, 'enviada');

      const { aplicarStatus } = require('../server/lib/recepcao');
      aplicarStatus(db, [{ id: saida.wa_id, status: 'delivered' }]);
      assert.equal(db.prepare('SELECT status FROM mensagens WHERE id = ?').get(saida.id).status, 'entregue');

      aplicarStatus(db, [{ id: saida.wa_id, status: 'read' }]);
      assert.equal(db.prepare('SELECT status FROM mensagens WHERE id = ?').get(saida.id).status, 'lida');

      // Evento atrasado da Meta não pode rebaixar "lida" para "entregue".
      aplicarStatus(db, [{ id: saida.wa_id, status: 'delivered' }]);
      assert.equal(db.prepare('SELECT status FROM mensagens WHERE id = ?').get(saida.id).status, 'lida');
    } finally { sem.restaurar(); }
  });

  test('falha da Meta marca a mensagem e guarda o motivo', async () => {
    const { db } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const saida = db.prepare("SELECT * FROM mensagens WHERE direcao = 'saida' AND wa_id IS NOT NULL ORDER BY id LIMIT 1").get();
      require('../server/lib/recepcao').aplicarStatus(db, [{ id: saida.wa_id, status: 'failed', errors: [{ title: 'Número não existe no WhatsApp' }] }]);
      const depois = db.prepare('SELECT status, erro FROM mensagens WHERE id = ?').get(saida.id);
      assert.equal(depois.status, 'falhou');
      assert.match(depois.erro, /não existe no WhatsApp/);
    } finally { sem.restaurar(); }
  });
});

describe('janela de 24 horas', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('fora da janela, a mensagem livre não é enviada e o motivo fica claro', async () => {
    const { db } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const c = h.conversaDoCliente(db);
      // Simula que a última mensagem do cliente foi há dois dias.
      db.prepare('UPDATE conversas SET janela_expira_em = ? WHERE id = ?').run(new Date(Date.now() - 86_400_000).toISOString(), c.id);
      const envio = require('../server/lib/envio');
      envio.enfileirar(db, db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), { autor: 'atendente', tipo: 'texto', texto: 'Oi, tudo bem?' });
      await envio.processarFila(db);
      const m = db.prepare("SELECT * FROM mensagens WHERE texto = 'Oi, tudo bem?'").get();
      assert.equal(m.status, 'falhou');
      assert.match(m.erro, /24 horas/);
      assert.match(m.erro, /template/);
    } finally { sem.restaurar(); }
  });

  test('fora da janela, o template passa', async () => {
    const { db } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const c = h.conversaDoCliente(db);
      db.prepare('UPDATE conversas SET janela_expira_em = NULL WHERE id = ?').run(c.id);
      const envio = require('../server/lib/envio');
      const wa = require('../server/lib/whatsapp');
      const { to: _to, recipient_type: _rt, ...payload } = wa.corpos.template('', 'aviso_fatura', 'pt_BR', ['João']);
      envio.enfileirar(db, db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), { autor: 'atendente', tipo: 'template', texto: '[template]', payload });
      await envio.processarFila(db);
      const m = db.prepare("SELECT * FROM mensagens WHERE tipo = 'template'").get();
      assert.equal(m.status, 'enviada');
      const enviado = meta.enviadas.at(-1);
      assert.equal(enviado.corpo.type, 'template');
      assert.equal(enviado.corpo.template.name, 'aviso_fatura');
    } finally { sem.restaurar(); }
  });
});
