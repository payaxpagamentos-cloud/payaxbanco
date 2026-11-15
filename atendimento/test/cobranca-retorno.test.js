'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
const regua = require('../server/lib/regua');
const custo = require('../server/lib/custo');
const conversas = require('../server/lib/conversas');
const relatorios = require('../server/lib/relatorios');
const manutencao = require('../server/lib/manutencao');
const { aoVivo } = require('../server/lib/aovivo');
const { hoje, somarDias } = require('../server/lib/datas');
const { agora } = require('../server/db');

/**
 * Cobrança com dois caminhos: a mensagem paga sai com botões, e a resposta do cliente (que abre a
 * janela de 24 h) volta para a ZOE resolver de graça — sem passar pela fila da equipe.
 */
const TELEFONE = '5511980000000';
const umaFatura = () => ({
  clientes: [{ id: '900', razao: 'Joana Prado', cnpj_cpf: '123.456.789-09', ativo: 'S', telefone_celular: '(11) 98000-0000' }],
  faturas: [{ id: '700', id_cliente: '900', id_contrato: '77', status: 'A', data_vencimento: somarDias(hoje(), 3), valor_aberto: '129.90' }],
  contratos: [], logins: [], chamados: [],
});
const BOTOES = 'segunda_via\nja_paguei\natendente';
const novaRegua = (db, empresaId, extra = {}) => regua.salvar(db, empresaId, {
  nome: 'Lembrete de vencimento', tipo: 'cobranca', categoria: 'utilidade', template: 'aviso_fatura',
  parametros: 'primeiro_nome\nvencimento\nvalor', gatilho: 'dias_antes_vencimento', dias: 3, ativa: true,
  preferir_janela: false, botoes: BOTOES, ...extra,
});
const toque = (texto, payload) => ({ id: `wamid.${crypto.randomBytes(6).toString('hex')}`, type: 'button', button: { text: texto, payload } });

test('template de utilidade com a janela aberta é grátis; marketing não', () => {
  assert.equal(custo.classificar({ janelaAberta: true, template: true, categoriaDoTemplate: 'utilidade' }), 'servico');
  assert.equal(custo.classificar({ janelaAberta: false, template: true, categoriaDoTemplate: 'utilidade' }), 'utilidade');
  assert.equal(custo.classificar({ janelaAberta: true, template: true, categoriaDoTemplate: 'marketing' }), 'marketing');
  assert.equal(custo.classificar({ janelaAberta: true, template: false }), 'servico');
});

describe('cobrança com retorno pela ZOE', () => {
  let meta;
  let ixc;
  let ambiente;
  beforeEach(() => {
    meta = h.fingirMeta();
    ambiente = h.criarAmbiente();
    h.comIxc(ambiente.db, ambiente.empresa.id);
    ixc = h.fingirIxc(umaFatura());
  });
  afterEach(() => { meta.restaurar(); ixc?.restaurar(); });

  const disparar = async (extra) => {
    const { db, empresa } = ambiente;
    const r = novaRegua(db, empresa.id, extra);
    const exec = await regua.executar(db, empresa, r);
    const conversa = db.prepare('SELECT * FROM conversas WHERE contato_id = (SELECT id FROM contatos WHERE telefone = ?) ORDER BY id DESC LIMIT 1').get(TELEFONE);
    return { r, exec, conversa };
  };

  test('a cobrança sai com os botões e fica com a ZOE, fora da fila, do painel e dos relatórios', async () => {
    const { db, empresa } = ambiente;
    const { r, exec, conversa } = await disparar();
    assert.equal(exec.enviados, 1);
    assert.equal(exec.custo_milesimos, 35, 'fora da janela, a cobrança é paga');

    const m = db.prepare("SELECT payload FROM mensagens WHERE conversa_id = ? AND tipo = 'template'").get(conversa.id);
    const botoes = JSON.parse(m.payload).template.components.filter((c) => c.type === 'button');
    assert.deepEqual(botoes.map((b) => [b.sub_type, b.index, b.parameters[0].payload]),
      [['quick_reply', '0', `zoe:segunda_via:${r.id}`], ['quick_reply', '1', `zoe:ja_paguei:${r.id}`], ['quick_reply', '2', `zoe:atendente:${r.id}`]]);

    assert.equal(conversa.estado, 'bot', 'com a ZOE, não na fila da equipe');
    assert.equal(conversa.ixc_cliente_id, '900', 'já sabe quem é no IXC');
    assert.equal(conversa.identidade_confirmada, 0, 'mas o portão de identidade continua fechado');
    const aviso = conversas.lerAviso(conversa);
    assert.equal(aviso.fatura_id, '700');
    assert.equal(aviso.via, 'template');

    // Aviso sem resposta não é atendimento.
    assert.equal(relatorios.resumo(db, { empresaId: empresa.id }).conversas, 0);
    assert.equal(conversas.listar(db, empresa.id, { caixa: 'abertas' }).total, 0);
    assert.equal(aoVivo(db, empresa.id).agora.com_zoe, 0);
  });

  test('"Falar com atendente" vai direto para a fila, sem gastar IA', async () => {
    const { db, empresa } = ambiente;
    const { r, conversa } = await disparar();
    const sem = h.semIa();
    try {
      await h.entregar(db, h.corpoWebhook(toque('Falar com atendente', `zoe:atendente:${r.id}`), { telefone: TELEFONE }));
    } finally { sem.restaurar(); }
    const depois = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);
    assert.ok(['aguardando', 'humano'].includes(depois.estado), 'saiu da ZOE para a equipe (e já pode ter sido assumida)');
    assert.ok(depois.transferida_em);
    assert.match(depois.motivo_transferencia, /Falar com atendente/);
    // Agora é atendimento: entra na conta.
    assert.equal(relatorios.resumo(db, { empresaId: empresa.id }).conversas, 1);
  });

  test('"Pagar com PIX" cai na ZOE, que entra no assunto da fatura sem cumprimentar de novo', async () => {
    const { db } = ambiente;
    const { r, conversa } = await disparar();
    const ia = h.fingirIa([{ texto: 'Claro! Para te mandar o PIX, me confirma os 3 primeiros números do CPF do titular?' }]);
    try {
      await h.entregar(db, h.corpoWebhook(toque('Pagar com PIX / 2ª via', `zoe:segunda_via:${r.id}`), { telefone: TELEFONE }));
    } finally { ia.restaurar(); }
    assert.equal(ia.pedidos.length, 1);
    const enviado = JSON.stringify(ia.pedidos[0].messages);
    assert.match(enviado, /Lembrete de vencimento/, 'a ZOE sabe de que aviso se trata');
    assert.match(enviado, /fatura 700/);
    const saidas = db.prepare("SELECT autor, texto, categoria FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND tipo = 'texto'").all(conversa.id);
    assert.equal(saidas.length, 1, 'só a resposta, sem saudação de abertura');
    assert.equal(saidas[0].categoria, 'servico', 'dentro da janela que o toque abriu: grátis');
    assert.equal(db.prepare('SELECT estado FROM conversas WHERE id = ?').get(conversa.id).estado, 'bot');
  });

  test('com a janela aberta, a cobrança vai como template de utilidade sem custo', async () => {
    const { db } = ambiente;
    // O cliente falou com a ZOE há pouco: a janela está aberta.
    const sem = h.semIa();
    try { await h.conversar(db, 'oi, bom dia', { telefone: TELEFONE }); } finally { sem.restaurar(); }
    const { exec } = await disparar({ pular_se_conversa_aberta: false });
    assert.equal(exec.enviados, 1);
    assert.equal(exec.custo_milesimos, 0);
    assert.equal(exec.pela_janela, 1);
    const d = db.prepare("SELECT categoria, custo_milesimos, economia_milesimos FROM disparos WHERE status = 'enviado'").get();
    assert.deepEqual([d.categoria, d.custo_milesimos, d.economia_milesimos], ['servico', 0, 35]);
  });

  test('aviso sem resposta fecha em 3 dias sem pedir avaliação, e a resposta depois disso herda o aviso', async () => {
    const { db } = ambiente;
    const { conversa } = await disparar();
    db.prepare('UPDATE conversas SET aberta_em = ? WHERE id = ?').run(new Date(Date.now() - 2 * 86_400_000).toISOString(), conversa.id);
    manutencao.encerrarAbandonadas(db);
    assert.equal(db.prepare('SELECT estado FROM conversas WHERE id = ?').get(conversa.id).estado, 'bot', 'com 2 dias ainda espera a resposta');

    db.prepare('UPDATE conversas SET aberta_em = ? WHERE id = ?').run(new Date(Date.now() - 4 * 86_400_000).toISOString(), conversa.id);
    const antes = db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND tipo <> 'sistema'").get(conversa.id).n;
    manutencao.encerrarAbandonadas(db);
    assert.equal(db.prepare('SELECT estado FROM conversas WHERE id = ?').get(conversa.id).estado, 'encerrada');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND tipo <> 'sistema'").get(conversa.id).n, antes,
      'nada enviado ao cliente (só a nota interna de encerramento)');

    const sem = h.semIa();
    try { await h.conversar(db, 'quero pagar a fatura', { telefone: TELEFONE }); } finally { sem.restaurar(); }
    const nova = db.prepare('SELECT * FROM conversas WHERE contato_id = ? ORDER BY id DESC LIMIT 1').get(conversa.contato_id);
    assert.notEqual(nova.id, conversa.id);
    assert.equal(conversas.lerAviso(nova)?.fatura_id, '700', 'a conversa nova sabe de que fatura se trata');
  });

  test('sem o retorno pela ZOE, a resposta cai na fila como antes', async () => {
    const { conversa } = await disparar({ retorno_zoe: false });
    assert.equal(conversa.estado, 'aguardando');
  });

  test('botão desconhecido é recusado ao salvar', () => {
    const { db, empresa } = ambiente;
    assert.throws(() => novaRegua(db, empresa.id, { nome: 'Outra', botoes: 'segunda_via\nsorteio' }), /Botão desconhecido/);
  });
});
