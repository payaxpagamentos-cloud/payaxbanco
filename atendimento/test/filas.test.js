'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const filas = require('../server/lib/filas');
const conversas = require('../server/lib/conversas');
const empresasLib = require('../server/lib/empresas');
const { manutencao, encerrarAbandonadas, soltarAtendentesAusentes } = require('../server/lib/manutencao');
const { agora } = require('../server/db');

describe('filas e distribuição', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('horário de atendimento, inclusive virando a meia-noite', () => {
    const comercial = { dias: '0111110', abre: '08:00', fecha: '18:00' };
    const noturna = { dias: '1111111', abre: '18:00', fecha: '02:00' };
    // 2026-11-11 é uma quarta-feira. 18:00 UTC = 15:00 em São Paulo.
    assert.equal(filas.dentroHorario(comercial, new Date('2026-11-11T18:00:00Z')), true);
    assert.equal(filas.dentroHorario(comercial, new Date('2026-11-12T01:00:00Z')), false, 'quarta às 22h está fechado');
    assert.equal(filas.dentroHorario(comercial, new Date('2026-11-15T18:00:00Z')), false, 'domingo está fechado');
    assert.equal(filas.dentroHorario(noturna, new Date('2026-11-12T02:00:00Z')), true, '23h entra na fila noturna');
    assert.equal(filas.dentroHorario(noturna, new Date('2026-11-12T04:00:00Z')), true, '01h ainda é a noite anterior');
    assert.equal(filas.dentroHorario(noturna, new Date('2026-11-12T13:00:00Z')), false, '10h está fora');
  });

  test('entrega ao atendente mais livre e respeita o máximo de conversas', () => {
    const { db, empresa, atendente, filas: lista } = h.criarAmbiente();
    db.prepare('UPDATE usuarios SET max_simultaneas = 2 WHERE id = ?').run(atendente.id);
    const fila = lista[0];
    const abrir = (telefone) => {
      const contato = conversas.garantirContato(db, empresa.id, telefone, null);
      const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
      const c = conversas.abrir(db, { empresa, numero, contato });
      conversas.transferir(db, c, { fila, motivo: 'teste', avisar: false });
      return db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id);
    };
    assert.equal(abrir('5511900000001').estado, 'humano');
    assert.equal(abrir('5511900000002').estado, 'humano');
    // A terceira passa do limite: fica esperando.
    const terceira = abrir('5511900000003');
    assert.equal(terceira.estado, 'aguardando');
    assert.equal(terceira.atendente_id, null);

    // Encerrar uma libera a vaga e a que estava na fila entra.
    const primeira = db.prepare("SELECT * FROM conversas WHERE estado = 'humano' ORDER BY id LIMIT 1").get();
    conversas.encerrar(db, primeira, { resolvidaPor: 'humano', avisar: false });
    assert.equal(db.prepare('SELECT estado FROM conversas WHERE id = ?').get(terceira.id).estado, 'humano');
  });

  test('a prioridade alta é entregue antes das normais', () => {
    const { db, empresa, atendente, filas: lista } = h.criarAmbiente({ atendenteDisponivel: false });
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
    const naFila = (telefone, prioridade) => {
      const contato = conversas.garantirContato(db, empresa.id, telefone, null);
      const c = conversas.abrir(db, { empresa, numero, contato });
      conversas.transferir(db, c, { fila: lista[0], motivo: 'teste', avisar: false });
      db.prepare('UPDATE conversas SET prioridade = ? WHERE id = ?').run(prioridade, c.id);
      return c.id;
    };
    const normal = naFila('5511900000011', 'normal');
    const alta = naFila('5511900000012', 'alta');

    db.prepare('UPDATE usuarios SET disponivel = 1, max_simultaneas = 1 WHERE id = ?').run(atendente.id);
    filas.girarFila(db, empresa.id);
    assert.equal(db.prepare('SELECT estado FROM conversas WHERE id = ?').get(alta).estado, 'humano', 'a alta foi primeiro');
    assert.equal(db.prepare('SELECT estado FROM conversas WHERE id = ?').get(normal).estado, 'aguardando');
  });

  test('o atendente só vê as filas que atende', async () => {
    const { db, empresa, atendente, filas: lista } = h.criarAmbiente({ atendenteDisponivel: false });
    // Marina sai da fila Financeiro.
    db.prepare('DELETE FROM fila_usuarios WHERE fila_id = ? AND usuario_id = ?').run(lista[1].id, atendente.id);
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
    for (const [i, fila] of lista.entries()) {
      const contato = conversas.garantirContato(db, empresa.id, `551190000002${i}`, null);
      const c = conversas.abrir(db, { empresa, numero, contato });
      conversas.transferir(db, c, { fila, motivo: 'teste', avisar: false });
    }
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(atendente.id);
    const vistas = conversas.listar(db, empresa.id, { caixa: 'abertas', usuario }).itens;
    assert.deepEqual([...new Set(vistas.map((c) => c.fila_nome))], [lista[0].nome], 'só a fila dele');

    // E não consegue assumir a que não é dele.
    const alheia = db.prepare('SELECT id FROM conversas WHERE fila_id = ?').get(lista[1].id);
    assert.throws(() => conversas.assumir(db, empresa.id, alheia.id, usuario), /não atende esta fila/i);
  });

  test('desativar um atendente devolve as conversas dele para a fila', () => {
    const { db, empresa, atendente, admin, filas: lista } = h.criarAmbiente();
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
    const contato = conversas.garantirContato(db, empresa.id, '5511900000031', null);
    const c = conversas.abrir(db, { empresa, numero, contato });
    conversas.transferir(db, c, { fila: lista[0], motivo: 'teste', avisar: false });
    assert.equal(db.prepare('SELECT atendente_id FROM conversas WHERE id = ?').get(c.id).atendente_id, atendente.id);

    // Como faz a rota ao desativar: tira da distribuição e devolve as conversas dele.
    db.prepare('UPDATE usuarios SET ativo = 0, disponivel = 0 WHERE id = ?').run(atendente.id);
    conversas.devolver(db, db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), { id: admin.id, nome: 'Carlos Lima' }, 'desativado');
    const depois = db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id);
    assert.equal(depois.estado, 'aguardando', 'volta para a fila: ninguém mais está disponível');
    assert.equal(depois.atendente_id, null);
    assert.match(db.prepare("SELECT texto FROM mensagens WHERE conversa_id = ? AND tipo = 'sistema' ORDER BY id DESC LIMIT 1").get(c.id).texto, /devolveu para a fila/);

    // Com outra pessoa disponível, a conversa é entregue na hora em vez de esperar.
    db.prepare('UPDATE usuarios SET disponivel = 1 WHERE id = ?').run(admin.id);
    filas.girarFila(db, empresa.id);
    assert.equal(db.prepare('SELECT atendente_id FROM conversas WHERE id = ?').get(c.id).atendente_id, admin.id);
  });

  test('o limite de atendentes do plano é respeitado', () => {
    const { db, empresa } = h.criarAmbiente();
    db.prepare('UPDATE empresas SET limite_atendentes = 2 WHERE id = ?').run(empresa.id);
    assert.throws(() => empresasLib.criarUsuario(db, empresa.id, { nome: 'Extra', email: 'extra@fibramais.com.br', perfil: 'atendente' }), /limite do plano/);
    // Supervisor não ocupa vaga de atendente.
    assert.doesNotThrow(() => empresasLib.criarUsuario(db, empresa.id, { nome: 'Supervisora', email: 'sup@fibramais.com.br', perfil: 'supervisor' }));
  });
});

describe('manutenção automática', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('conversa sem resposta do cliente é encerrada como abandono', async () => {
    const { db, empresa } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const c = h.conversaDoCliente(db);
      db.prepare('UPDATE ia_config SET encerrar_apos_min = 60 WHERE empresa_id = ?').run(empresa.id);
      db.prepare('UPDATE conversas SET ultima_mensagem_cliente_em = ? WHERE id = ?').run(new Date(Date.now() - 2 * 3600_000).toISOString(), c.id);
      const encerradas = encerrarAbandonadas(db);
      assert.deepEqual(encerradas, [c.id]);
      const depois = db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id);
      assert.equal(depois.estado, 'encerrada');
      assert.equal(depois.resolvida_por, 'abandono');
      assert.equal(depois.csat_pedido_em, null, 'não pede avaliação de quem sumiu');
    } finally { sem.restaurar(); }
  });

  test('atendente que fechou o painel sai da distribuição', () => {
    const { db, atendente } = h.criarAmbiente();
    db.prepare('UPDATE usuarios SET visto_em = ? WHERE id = ?').run(new Date(Date.now() - 30 * 60_000).toISOString(), atendente.id);
    assert.equal(soltarAtendentesAusentes(db), 1);
    assert.equal(db.prepare('SELECT disponivel FROM usuarios WHERE id = ?').get(atendente.id).disponivel, 0);
  });

  test('a rotina de minuto roda inteira sem erro', async () => {
    const { db } = h.criarAmbiente();
    const r = await manutencao(db);
    assert.ok(Array.isArray(r.abandonadas));
    assert.ok(Array.isArray(r.entregues));
  });
});

describe('avaliação do atendimento (CSAT)', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('a nota do cliente entra na conversa encerrada, sem abrir uma nova', async () => {
    const { db, empresa } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const c = h.conversaDoCliente(db);
      conversas.encerrar(db, db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), { resolvidaPor: 'humano' });
      assert.ok(db.prepare('SELECT csat_pedido_em FROM conversas WHERE id = ?').get(c.id).csat_pedido_em, 'pediu a avaliação');

      await h.conversar(db, '5');
      assert.equal(db.prepare('SELECT csat_nota FROM conversas WHERE id = ?').get(c.id).csat_nota, 5);
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM conversas WHERE empresa_id = ?').get(empresa.id).n), 1, 'não abriu conversa nova');
      assert.match(meta.enviadas.map((m) => m.texto).join(' '), /Obrigado pela avaliação/);
    } finally { sem.restaurar(); }
  });

  test('uma mensagem que não é nota abre uma conversa nova', async () => {
    const { db, empresa } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const c = h.conversaDoCliente(db);
      conversas.encerrar(db, db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), { resolvidaPor: 'humano' });
      await h.conversar(db, 'na verdade tenho outra dúvida');
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM conversas WHERE empresa_id = ?').get(empresa.id).n), 2);
      assert.equal(h.conversaDoCliente(db).estado, 'bot', 'a conversa nova começa com a ZOE');
    } finally { sem.restaurar(); }
  });
});
