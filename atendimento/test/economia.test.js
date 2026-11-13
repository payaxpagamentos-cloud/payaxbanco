'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const regua = require('../server/lib/regua');
const pendencias = require('../server/lib/pendencias');
const orcamento = require('../server/lib/orcamento');
const fechamento = require('../server/lib/fechamento');
const custo = require('../server/lib/custo');
const conversas = require('../server/lib/conversas');
const { hoje, somarDias } = require('../server/lib/datas');
const { agora } = require('../server/db');

/** Cadastro com N faturas vencendo na data que a régua procura. */
const comFaturas = (quantos, { venceEm = 3 } = {}) => {
  const vencimento = somarDias(hoje(), venceEm);
  const clientes = [];
  const faturas = [];
  for (let i = 0; i < quantos; i++) {
    const id = String(900 + i);
    clientes.push({ id, razao: `Cliente ${i + 1}`, cnpj_cpf: '123.456.789-09', ativo: 'S', telefone_celular: `(11) 98000-000${i}` });
    faturas.push({ id: `70${i}`, id_cliente: id, id_contrato: '77', status: 'A', data_vencimento: vencimento, valor_aberto: '129.90' });
  }
  return { clientes, faturas, contratos: [], logins: [], chamados: [] };
};

const novaRegua = (db, empresaId, extra = {}) => regua.salvar(db, empresaId, {
  nome: 'Lembrete de vencimento', tipo: 'cobranca', categoria: 'utilidade',
  template: 'aviso_fatura', parametros: 'primeiro_nome\nvencimento\nvalor',
  texto_janela: 'Oi {primeiro_nome}! Sua fatura de {valor} vence em {vencimento}. Quer que eu mande o PIX?',
  gatilho: 'dias_antes_vencimento', dias: 3, ativa: true, ...extra,
});

/** A sala de espera: o aviso que tem folga não vira template pago hoje. */
describe('espera pela janela', () => {
  let meta;
  let ixc;
  let ambiente;

  beforeEach(() => {
    meta = h.fingirMeta();
    ambiente = h.criarAmbiente();
    h.comIxc(ambiente.db, ambiente.empresa.id);
  });
  afterEach(() => { meta.restaurar(); ixc?.restaurar(); });

  test('com folga de prazo, nada é pago: o aviso vai para a sala de espera', async () => {
    const { db, empresa } = ambiente;
    ixc = h.fingirIxc(comFaturas(5));
    const r = novaRegua(db, empresa.id, { esperar_janela_h: 24 });

    const s = await regua.simular(db, empresa, r);
    assert.equal(s.esperando, 5, 'os cinco esperam a janela');
    assert.equal(s.por_template, 0);
    assert.equal(s.custo_milesimos, 0, 'nenhum centavo gasto agora');

    const exec = await regua.executar(db, empresa, r);
    assert.equal(exec.esperando, 5);
    assert.equal(exec.enviados, 0);
    assert.equal(exec.custo_milesimos, 0);
    assert.equal(pendencias.resumo(db, empresa.id).esperando, 5);
    assert.equal(pendencias.resumo(db, empresa.id).em_risco_milesimos, 5 * 35, 'o que seria gasto se ninguém escrever');
  });

  test('o cliente escreve e o aviso sai de graça, de carona na resposta', async () => {
    const { db, empresa } = ambiente;
    ixc = h.fingirIxc(comFaturas(1));
    const r = novaRegua(db, empresa.id, { esperar_janela_h: 48 });
    await regua.executar(db, empresa, r);
    assert.equal(pendencias.resumo(db, empresa.id).esperando, 1);

    // O cliente manda qualquer coisa: a janela abre.
    const sem = h.semIa();
    try {
      await h.conversar(db, 'bom dia, quanto está minha fatura?', { telefone: '5511980000000' });
    } finally { sem.restaurar(); }

    const p = db.prepare('SELECT * FROM pendencias ORDER BY id DESC LIMIT 1').get();
    assert.equal(p.status, 'entregue');
    assert.equal(p.resolucao, 'janela', 'saiu pela janela, não por template');

    const d = db.prepare("SELECT * FROM disparos WHERE status = 'enviado' ORDER BY id DESC LIMIT 1").get();
    assert.equal(d.categoria, 'servico');
    assert.equal(d.custo_milesimos, 0);
    assert.equal(d.economia_milesimos, 35, 'economizou o preço do template');

    const m = db.prepare('SELECT texto, categoria, custo_milesimos FROM mensagens WHERE id = ?').get(d.mensagem_id);
    assert.match(m.texto, /Aproveitando que você está por aqui/);
    assert.match(m.texto, /vence em/);
    assert.equal(m.custo_milesimos, 0);
  });

  test('vários avisos do mesmo cliente saem numa mensagem só', async () => {
    const { db, empresa } = ambiente;
    const cadastro = comFaturas(1);
    cadastro.faturas.push({ id: '799', id_cliente: '900', id_contrato: '78', status: 'A', data_vencimento: somarDias(hoje(), 3), valor_aberto: '59.90' });
    ixc = h.fingirIxc(cadastro);
    const r = novaRegua(db, empresa.id, { esperar_janela_h: 48 });
    await regua.executar(db, empresa, r);
    assert.equal(pendencias.resumo(db, empresa.id).esperando, 2, 'duas faturas, duas pendências');

    const sem = h.semIa();
    try { await h.conversar(db, 'oi', { telefone: '5511980000000' }); } finally { sem.restaurar(); }

    const entregues = db.prepare("SELECT mensagem_id FROM disparos WHERE status = 'enviado'").all();
    assert.equal(entregues.length, 2, 'os dois avisos foram entregues');
    assert.equal(new Set(entregues.map((x) => x.mensagem_id)).size, 1, 'na mesma mensagem');
    const m = db.prepare('SELECT texto FROM mensagens WHERE id = ?').get(entregues[0].mensagem_id);
    assert.equal((m.texto.match(/•/g) ?? []).length, 2, 'uma linha por aviso');
  });

  test('passado o prazo sem o cliente escrever, aí sim paga o template', async () => {
    const { db, empresa } = ambiente;
    ixc = h.fingirIxc(comFaturas(2));
    const r = novaRegua(db, empresa.id, { esperar_janela_h: 24 });
    await regua.executar(db, empresa, r);

    // Empurra o prazo para trás: é o que o tempo faria.
    db.prepare("UPDATE pendencias SET prazo = ? WHERE status = 'esperando'").run(somarDias(hoje(), -1) + 'T00:00:00.000Z');
    const varrida = await regua.pagarVencidas(db);
    assert.equal(varrida.pagas, 2);
    assert.equal(varrida.custo_milesimos, 2 * 35, 'agora pagou, no último momento útil');

    const p = db.prepare('SELECT status, resolucao FROM pendencias LIMIT 1').get();
    assert.equal(p.status, 'entregue');
    assert.equal(p.resolucao, 'template');
    const d = db.prepare("SELECT motivo FROM disparos WHERE status = 'enviado' LIMIT 1").get();
    assert.match(d.motivo, /prazo da espera acabou/);
  });

  test('a fatura paga durante a espera não é cobrada', async () => {
    const { db, empresa } = ambiente;
    const cadastro = comFaturas(2);
    ixc = h.fingirIxc(cadastro);
    const r = novaRegua(db, empresa.id, { esperar_janela_h: 24, pular_se_pago: true });
    await regua.executar(db, empresa, r);
    assert.equal(pendencias.resumo(db, empresa.id).esperando, 2, 'as duas esperam');

    // Agora o cliente paga uma delas: é o que acontece na vida, entre o aviso e o prazo.
    ixc.restaurar();
    ixc = h.fingirIxc(cadastro, { pagasNaConsultaIndividual: ['700'] });
    db.prepare("UPDATE pendencias SET prazo = ? WHERE status = 'esperando'").run(somarDias(hoje(), -1) + 'T00:00:00.000Z');
    const varrida = await regua.pagarVencidas(db);
    assert.equal(varrida.canceladas, 1, 'a paga foi cancelada');
    assert.equal(varrida.pagas, 1, 'só a que continua em aberto foi paga');
    const cancelada = db.prepare("SELECT resolucao FROM pendencias WHERE status = 'cancelada'").get();
    assert.match(cancelada.resolucao, /paga enquanto o aviso esperava/);
  });

  test('não joga cobrança por cima de quem está falando com uma pessoa', async () => {
    const { db, empresa } = ambiente;
    ixc = h.fingirIxc(comFaturas(1));
    const r = novaRegua(db, empresa.id, { esperar_janela_h: 48, pular_se_conversa_aberta: false });
    await regua.executar(db, empresa, r);

    const contato = db.prepare('SELECT * FROM contatos WHERE telefone = ?').get('5511980000000');
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
    const conversa = conversas.abertaDoContato(db, contato.id) ?? conversas.abrir(db, { empresa, numero, contato });
    conversas.tocarJanela(db, conversa);
    db.prepare("UPDATE conversas SET estado = 'humano' WHERE id = ?").run(conversa.id);

    assert.equal(pendencias.aproveitarJanela(db, contato.id), null, 'espera a conversa humana terminar');
    assert.equal(pendencias.resumo(db, empresa.id).esperando, 1, 'continua esperando, e esperar não custa nada');
  });
});

/** Um recado pago por pessoa por dia. */
describe('limite de mensagens pagas por contato', () => {
  let meta;
  let ixc;
  let ambiente;
  beforeEach(() => { meta = h.fingirMeta(); ambiente = h.criarAmbiente(); h.comIxc(ambiente.db, ambiente.empresa.id); });
  afterEach(() => { meta.restaurar(); ixc?.restaurar(); });

  test('duas réguas no mesmo cliente no mesmo dia pagam uma vez só', async () => {
    const { db, empresa } = ambiente;
    ixc = h.fingirIxc(comFaturas(1));
    const primeira = novaRegua(db, empresa.id, { nome: 'Primeira' });
    const exec1 = await regua.executar(db, empresa, primeira);
    assert.equal(exec1.enviados, 1);
    assert.equal(exec1.custo_milesimos, 35);

    const segunda = novaRegua(db, empresa.id, { nome: 'Segunda', template: 'outro_aviso', pular_se_conversa_aberta: false });
    const exec2 = await regua.executar(db, empresa, segunda);
    assert.equal(exec2.enviados, 0, 'a segunda não paga de novo');
    assert.equal(exec2.pulados, 1);
    assert.equal(exec2.custo_milesimos, 0);
    const d = db.prepare("SELECT motivo FROM disparos WHERE status = 'pulado' ORDER BY id DESC LIMIT 1").get();
    assert.match(d.motivo, /já recebeu uma mensagem paga hoje/);
  });
});

/** Uma conversa de verdade para pendurar as mensagens de teste. */
function conversaDeTeste(db, empresa, telefone = '5511977776666') {
  const contato = conversas.garantirContato(db, empresa.id, telefone, 'Cliente do Custo');
  const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
  return conversas.abertaDoContato(db, contato.id) ?? conversas.abrir(db, { empresa, numero, contato });
}

/** O orçamento com freio: estourado, só sai mensagem grátis. */
describe('orçamento da conta da Meta', () => {
  let meta;
  let ixc;
  let ambiente;
  beforeEach(() => { meta = h.fingirMeta(); ambiente = h.criarAmbiente(); h.comIxc(ambiente.db, ambiente.empresa.id); });
  afterEach(() => { meta.restaurar(); ixc?.restaurar(); });

  test('sem teto não há freio', () => {
    const { db, empresa } = ambiente;
    const st = orcamento.estado(db, empresa.id);
    assert.equal(st.status, 'sem_teto');
    assert.equal(orcamento.permite(db, empresa.id, 'utilidade').ok, true);
  });

  test('o teto para o gasto antes de estourar, e a mensagem grátis continua saindo', async () => {
    const { db, empresa } = ambiente;
    // Teto de R$ 0,07: cabem duas mensagens de utilidade.
    orcamento.definir(db, empresa.id, { orcamento_milesimos: 70 });
    ixc = h.fingirIxc(comFaturas(5));
    const r = novaRegua(db, empresa.id, { repetir_apos_dias: 0 });

    const exec = await regua.executar(db, empresa, r);
    assert.equal(exec.enviados, 2, 'só duas couberam no orçamento');
    assert.equal(exec.custo_milesimos, 70);
    assert.ok(exec.pulados >= 1, 'o resto foi barrado pelo freio');
    const d = db.prepare("SELECT motivo FROM disparos WHERE status = 'pulado' ORDER BY id DESC LIMIT 1").get();
    assert.match(d.motivo, /orçamento do mês acabou/);

    assert.equal(orcamento.estado(db, empresa.id).status, 'estourado');
    // Serviço nunca é barrado: o atendimento não para por causa de dinheiro que não é cobrado.
    assert.equal(orcamento.permite(db, empresa.id, 'servico').ok, true);
    assert.equal(orcamento.permite(db, empresa.id, 'utilidade').ok, false);
  });

  test('marketing tem teto próprio e não come o dinheiro da cobrança', () => {
    const { db, empresa } = ambiente;
    orcamento.definir(db, empresa.id, { orcamento_milesimos: 100_000, orcamento_marketing_milesimos: 320 });
    // Uma mensagem de marketing cabe; a segunda não.
    const alvo = conversaDeTeste(db, empresa);
    assert.equal(orcamento.permite(db, empresa.id, 'marketing').ok, true);
    db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', 'template', '[campanha]', 'wa-mkt-1', 'marketing', 320, 'entregue', ?)`)
      .run(alvo.id, empresa.id, agora());
    const freio = orcamento.permite(db, empresa.id, 'marketing');
    assert.equal(freio.ok, false);
    assert.match(freio.motivo, /orçamento de marketing/);
    assert.equal(orcamento.permite(db, empresa.id, 'utilidade').ok, true, 'a cobrança continua liberada');
  });

  test('os marcos de 50, 80 e 100% são avisados uma vez só', () => {
    const { db, empresa } = ambiente;
    orcamento.definir(db, empresa.id, { orcamento_milesimos: 100 });
    const conversa = conversaDeTeste(db, empresa);
    const gastar = (quanto, i) => db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', 'template', '[x]', ?, 'utilidade', ?, 'entregue', ?)`)
      .run(conversa.id, empresa.id, `wa-orc-${i}`, quanto, agora());

    gastar(55, 1);
    assert.deepEqual(orcamento.conferirMarcos(db, empresa.id).map((x) => x.marco), [50]);
    assert.deepEqual(orcamento.conferirMarcos(db, empresa.id).map((x) => x.marco), [], 'não avisa de novo');
    gastar(50, 2);
    assert.deepEqual(orcamento.conferirMarcos(db, empresa.id).map((x) => x.marco), [80, 100]);
    assert.equal(orcamento.avisos(db, empresa.id).length, 3);
  });
});

/** O fechamento: onde o número para de se mover e passa a ser conferido. */
describe('fechamento mensal', () => {
  let ambiente;
  beforeEach(() => { ambiente = h.criarAmbiente(); });

  const gastar = (db, empresa, quanto, quando, i) => {
    const conversa = conversaDeTeste(db, empresa);
    db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', 'template', '[x]', ?, 'utilidade', ?, 'entregue', ?)`)
      .run(conversa.id, empresa.id, `wa-fech-${i}`, quanto, quando);
  };

  test('fecha o mês, recalcula enquanto não foi conferido e congela depois', () => {
    const { db, empresa } = ambiente;
    const mes = fechamento.mesAnterior();
    gastar(db, empresa, 1000, `${mes}-15T10:00:00.000Z`, 1);

    const f1 = fechamento.fechar(db, empresa.id, mes);
    assert.equal(f1.mes, mes);
    assert.equal(f1.gasto_milesimos, 1000);
    assert.equal(f1.gasto_centavos, 100, 'R$ 1,00 em centavos');
    assert.equal(f1.recalculado, false);

    // Uma mensagem atrasada chegou: fechar de novo recalcula, porque ninguém conferiu ainda.
    gastar(db, empresa, 500, `${mes}-20T10:00:00.000Z`, 2);
    const f2 = fechamento.fechar(db, empresa.id, mes);
    assert.equal(f2.gasto_milesimos, 1500);
    assert.equal(f2.recalculado, true);

    // Conferido: a linha não se move mais.
    const conferido = fechamento.conferir(db, empresa.id, mes, { valor_centavos: 150, usuario: { nome: 'Gestão' } });
    assert.equal(conferido.fatura_meta_centavos, 150);
    assert.equal(conferido.diferenca_centavos, 0, 'a nossa conta bateu com a fatura');
    assert.equal(conferido.divergente, false);
    gastar(db, empresa, 9999, `${mes}-25T10:00:00.000Z`, 3);
    assert.equal(fechamento.fechar(db, empresa.id, mes).gasto_milesimos, 1500, 'mês conferido não recalcula');
  });

  test('diferença grande contra a fatura da Meta é apontada como divergência', () => {
    const { db, empresa } = ambiente;
    const mes = fechamento.mesAnterior();
    gastar(db, empresa, 100_000, `${mes}-10T10:00:00.000Z`, 1); // R$ 100,00
    fechamento.fechar(db, empresa.id, mes);
    const c = fechamento.conferir(db, empresa.id, mes, { valor_centavos: 18_000 }); // R$ 180,00
    assert.equal(c.diferenca_centavos, 8000, 'a Meta cobrou R$ 80,00 a mais');
    assert.equal(c.divergente, true, 'acima de 5% não é arredondamento');

    // Reabrir volta a permitir o lançamento.
    const reaberto = fechamento.reabrir(db, empresa.id, mes);
    assert.equal(reaberto.fatura_meta_centavos, null);
    assert.equal(reaberto.conferido_em, null);
  });

  test('a série traz o mês corrente em aberto na frente dos fechados', () => {
    const { db, empresa } = ambiente;
    const mes = fechamento.mesAnterior();
    gastar(db, empresa, 700, `${mes}-05T10:00:00.000Z`, 1);
    fechamento.fechar(db, empresa.id, mes);
    const s = fechamento.serie(db, empresa.id, { meses: 12 });
    assert.equal(s.meses[0].mes, hoje().slice(0, 7));
    assert.equal(s.meses[0].em_aberto, true);
    assert.equal(s.meses[1].mes, mes);
    assert.equal(s.meses[1].gasto_milesimos, 700);
  });

  test('não fecha um mês que ainda não começou', () => {
    const { db, empresa } = ambiente;
    const futuro = somarDias(hoje(), 400).slice(0, 7);
    assert.throws(() => fechamento.fechar(db, empresa.id, futuro), /ainda não começou/);
    assert.throws(() => fechamento.fechar(db, empresa.id, '2026-13'), /AAAA-MM/);
  });
});
