'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

/**
 * O comportamento que define o produto: a ZOE faz o primeiro atendimento e só o que
 * ela não resolve vai para a equipe humana.
 */
describe('ZOE', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('resolve sozinha com a base de conhecimento e encerra, sem ocupar ninguém', async () => {
    const { db, empresa } = h.criarAmbiente();
    h.comConhecimento(db, empresa.id, 'Horário de atendimento', 'De segunda a sexta, das 8h às 18h.', 'que horas vocês abrem?');
    const ia = h.fingirClaude([
      { ferramenta: 'buscar_conhecimento', entrada: { pergunta: 'horário de atendimento' } },
      { texto: 'A gente atende de segunda a sexta, das 8h às 18h.', ferramenta: 'encerrar_atendimento', entrada: { resumo: 'Cliente quis saber o horário.', despedida: null } },
    ]);
    try {
      await h.conversar(db, 'oi, qual o horário de atendimento de vocês?');
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'encerrada');
      assert.equal(c.resolvida_por, 'ia');
      assert.equal(c.atendente_id, null, 'nenhum atendente humano foi ocupado');
      const textos = meta.enviadas.map((m) => m.texto).join(' | ');
      assert.match(textos, /8h às 18h/);
      assert.equal(db.prepare("SELECT usos FROM conhecimento WHERE empresa_id = ? AND titulo = 'Horário de atendimento'").get(empresa.id).usos, 1);
    } finally { ia.restaurar(); }
  });

  test('transfere na hora quando o cliente pede uma pessoa, sem chamar a IA', async () => {
    const { db, atendente } = h.criarAmbiente();
    const ia = h.fingirClaude([{ texto: 'não deveria ser chamada' }]);
    try {
      await h.conversar(db, 'quero falar com um atendente humano');
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'humano', 'foi direto para o atendente disponível');
      assert.equal(c.atendente_id, atendente.id);
      assert.match(c.motivo_transferencia, /pediu atendimento humano/);
      assert.equal(ia.pedidos.length, 0, 'a IA não foi chamada: a regra resolveu antes');
      assert.match(meta.enviadas.map((m) => m.texto).join(' '), /transferir/i);
    } finally { ia.restaurar(); }
  });

  test('transfere com resumo quando a IA chama a ferramenta', async () => {
    const { db, atendente, filas } = h.criarAmbiente();
    const ia = h.fingirClaude([
      { ferramenta: 'buscar_conhecimento', entrada: { pergunta: 'desconto na fatura' } },
      { ferramenta: 'transferir_para_humano', entrada: { fila: 'Financeiro', motivo: 'Pedido de desconto exige decisão humana.', resumo: 'Cliente pede 50% de desconto na fatura de outubro. Não há regra na base.' } },
    ]);
    try {
      await h.conversar(db, 'consigo 50% de desconto na fatura de outubro?');
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'humano');
      assert.equal(c.atendente_id, atendente.id);
      assert.equal(c.fila_id, filas.find((f) => f.nome === 'Financeiro').id);
      assert.match(c.resumo, /50% de desconto/);
      assert.match(c.motivo_transferencia, /decisão humana/);
    } finally { ia.restaurar(); }
  });

  test('fica na fila quando não há atendente disponível e avisa o cliente uma única vez', async () => {
    const { db } = h.criarAmbiente({ atendenteDisponivel: false });
    const ia = h.fingirClaude([{ texto: 'x' }]);
    try {
      await h.conversar(db, 'preciso falar com uma pessoa');
      let c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'aguardando');
      assert.equal(c.atendente_id, null);
      const avisosAntes = meta.enviadas.length;
      await h.conversar(db, 'alô? tem alguém aí?');
      c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'aguardando');
      assert.equal(meta.enviadas.length, avisosAntes, 'não repete o aviso de transferência a cada mensagem');
    } finally { ia.restaurar(); }
  });

  test('a IA não fala por cima quando um humano já assumiu', async () => {
    const { db, empresa, atendente } = h.criarAmbiente();
    const conversas = require('../server/lib/conversas');
    const ia = h.fingirClaude([{ texto: 'não deveria falar' }]);
    try {
      await h.conversar(db, 'quero falar com alguém');
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'humano');
      const antes = meta.enviadas.length;
      ia.pedidos.length = 0;
      await h.conversar(db, 'e aí, tem novidade?');
      assert.equal(ia.pedidos.length, 0, 'a IA não é chamada em conversa com humano');
      assert.equal(meta.enviadas.length, antes, 'nada foi respondido automaticamente');
      assert.equal(h.conversaDoCliente(db).atendente_id, atendente.id);
      // A mensagem do cliente continua gravada para o atendente ler.
      assert.match(h.mensagensDe(db, c.id).map((m) => m.texto).join(' | '), /tem novidade/);
      void empresa; void conversas;
    } finally { ia.restaurar(); }
  });

  test('erro, recusa ou resposta vazia da IA viram transferência, não silêncio', async () => {
    for (const passo of [{ erro: new Error('timeout da API') }, { recusa: 'general_harms' }, { texto: '' }]) {
      const { db } = h.criarAmbiente();
      const ia = h.fingirClaude([passo]);
      try {
        await h.conversar(db, 'uma pergunta qualquer sobre o meu contrato');
        const c = h.conversaDoCliente(db);
        assert.equal(c.estado, 'humano', `desfecho ${JSON.stringify(Object.keys(passo))} deveria transferir`);
        assert.ok(c.motivo_transferencia, 'o motivo fica registrado para a equipe');
      } finally { ia.restaurar(); }
    }
  });

  test('respeita o limite de mensagens da IA por conversa', async () => {
    const { db, empresa } = h.criarAmbiente();
    db.prepare('UPDATE ia_config SET max_turnos = 2 WHERE empresa_id = ?').run(empresa.id);
    const ia = h.fingirClaude([{ texto: 'Pode me dar mais detalhes?' }]);
    try {
      await h.conversar(db, 'tenho um problema');
      await h.conversar(db, 'é complicado de explicar');
      assert.equal(h.conversaDoCliente(db).estado, 'bot');
      await h.conversar(db, 'continua complicado');
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'humano');
      assert.match(c.motivo_transferencia, /limite de 2 mensagens/);
    } finally { ia.restaurar(); }
  });

  test('sem chave de IA, cai no menu de departamentos e transfere pela escolha', async () => {
    const { db, filas } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'bom dia, preciso de ajuda com uma coisa');
      let c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'bot');
      const menu = meta.enviadas.find((m) => m.tipo === 'interactive');
      assert.ok(menu, 'mandou o menu de departamentos');
      assert.deepEqual(menu.corpo.interactive.action.buttons.map((b) => b.reply.title), filas.map((f) => f.nome));

      await h.entregar(db, h.corpoWebhook({ id: 'wamid.escolha', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: `fila:${filas[1].id}`, title: filas[1].nome } } }));
      c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'humano');
      assert.equal(c.fila_id, filas[1].id);
    } finally { sem.restaurar(); }
  });

  test('intenção cadastrada resolve antes da IA e nem chama o modelo', async () => {
    const { db, empresa, filas } = h.criarAmbiente();
    db.prepare("INSERT INTO intencoes (empresa_id, nome, palavras, acao, resposta, ordem, criada_em) VALUES (?, 'Rastreio', 'rastrear\nonde está meu pedido', 'responder', 'Acompanhe pelo link que enviamos no e-mail.', 1, ?)")
      .run(empresa.id, new Date().toISOString());
    const ia = h.fingirClaude([{ texto: 'não deveria ser chamada' }]);
    try {
      await h.conversar(db, 'quero rastrear meu pedido');
      assert.equal(ia.pedidos.length, 0);
      assert.match(meta.enviadas.map((m) => m.texto).join(' '), /Acompanhe pelo link/);
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'bot');
      assert.equal(c.intencao, 'Rastreio');
      assert.equal(db.prepare('SELECT usos FROM intencoes WHERE empresa_id = ?').get(empresa.id).usos, 1);
      void filas;
    } finally { ia.restaurar(); }
  });

  test('abre chamado com protocolo quando não há solução imediata', async () => {
    const { db, empresa } = h.criarAmbiente();
    const ia = h.fingirClaude([
      { ferramenta: 'abrir_chamado', entrada: { assunto: 'Internet oscilando à noite', descricao: 'Cai todo dia depois das 22h há uma semana.', fila: null } },
      { texto: 'Abri o chamado 202611-00001 para o time técnico. Você recebe a atualização por aqui.' },
    ]);
    try {
      await h.conversar(db, 'minha internet cai todo dia depois das 22h');
      const chamado = db.prepare('SELECT * FROM chamados WHERE empresa_id = ?').get(empresa.id);
      assert.ok(chamado, 'o chamado foi aberto');
      assert.equal(chamado.aberto_por, 'ia');
      assert.match(chamado.protocolo, /^\d{6}-\d{5}$/);
      assert.equal(chamado.status, 'aberto');
      assert.match(meta.enviadas.map((m) => m.texto).join(' '), /202611-00001/);
      assert.equal(h.conversaDoCliente(db).estado, 'bot', 'a conversa segue com a IA');
    } finally { ia.restaurar(); }
  });
});
