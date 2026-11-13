'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const custo = require('../server/lib/custo');
const regua = require('../server/lib/regua');
const conversas = require('../server/lib/conversas');
const envio = require('../server/lib/envio');
const { hoje, somarDias } = require('../server/lib/datas');
const { agora } = require('../server/db');

/** A tabela da Meta: o que cada mensagem custa e, principalmente, o que não custa. */
describe('custo das mensagens', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('dentro da janela de 24 h tudo é serviço e não custa nada', async () => {
    const { db } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi, preciso da segunda via');
      const saidas = db.prepare("SELECT categoria, custo_milesimos FROM mensagens WHERE direcao = 'saida' AND tipo <> 'sistema'").all();
      assert.ok(saidas.length, 'houve resposta');
      assert.ok(saidas.every((m) => m.categoria === 'servico'), 'toda resposta na janela é serviço');
      assert.ok(saidas.every((m) => m.custo_milesimos === 0), 'e serviço é de graça');
    } finally { sem.restaurar(); }
  });

  test('template cobra pela categoria dele, mesmo dentro da janela', async () => {
    const { db } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const c = h.conversaDoCliente(db);
      const wa = require('../server/lib/whatsapp');
      const { to: _t, recipient_type: _r, ...payload } = wa.corpos.template('', 'aviso', 'pt_BR', []);
      envio.enfileirar(db, c, { autor: 'sistema', tipo: 'template', texto: '[t]', payload, categoriaTemplate: 'marketing' });
      const m = db.prepare("SELECT categoria, custo_milesimos FROM mensagens WHERE tipo = 'template'").get();
      assert.equal(m.categoria, 'marketing');
      assert.equal(m.custo_milesimos, 320, 'R$ 0,32');
    } finally { sem.restaurar(); }
  });

  test('a tabela bate com a conta do provedor: 7.000 boletos', () => {
    const { db } = h.criarAmbiente();
    const p = custo.precos(db);
    assert.equal(custo.emReais(7000 * p.utilidade).replace(/ /g, ' '), 'R$ 245,00');
    assert.equal(custo.emReais(7000 * p.marketing).replace(/ /g, ' '), 'R$ 2.240,00');
    assert.equal(p.servico, 0);
    // Mandar como marketing o que é utilidade custa 9 vezes mais pelo mesmo texto.
    assert.equal(Math.round(p.marketing / p.utilidade), 9);
  });

  test('o resumo separa o que foi gasto do que deixou de ser gasto', async () => {
    const { db, empresa } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi, qual meu boleto?');
      const r = custo.resumo(db, empresa.id, { de: hoje(), ate: hoje() });
      const servico = r.por_categoria.find((x) => x.categoria === 'servico');
      assert.ok(servico.mensagens >= 1);
      assert.equal(r.gasto_milesimos, 0, 'só houve serviço: nada foi gasto');
      // Cada resposta de serviço é um template de utilidade que não precisou existir.
      assert.equal(r.economia.por_janela_de_servico.milesimos, servico.mensagens * 35);
      assert.ok(r.sem_otimizacao_milesimos > r.gasto_milesimos);
    } finally { sem.restaurar(); }
  });

  test('o disparo que foi pela janela conta uma vez só', async () => {
    const { db, empresa } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      // A conversa abre a janela de 24 h e já deixa respostas de serviço no histórico.
      await h.conversar(db, 'oi, tudo bem?');
      const conversa = Number(db.prepare('SELECT id FROM conversas ORDER BY id DESC LIMIT 1').get().id);
      const antes = custo.resumo(db, empresa.id, { de: hoje(), ate: hoje() });

      // Um disparo da régua que saiu pela janela: grava a mensagem de serviço
      // E o disparo com a economia, exatamente como em produção.
      const r = regua.salvar(db, empresa.id, {
        nome: 'Lembrete de vencimento', tipo: 'cobranca', categoria: 'utilidade',
        template: 'aviso_fatura', parametros: 'primeiro_nome',
        texto_janela: 'Oi {primeiro_nome}! Sua fatura vence em 3 dias.',
        gatilho: 'dias_antes_vencimento', dias: 3, ativa: true,
      });
      const contatoId = db.prepare('SELECT contato_id FROM conversas WHERE id = ?').get(conversa).contato_id;
      db.prepare(`INSERT INTO disparos (empresa_id, regua_id, contato_id, categoria, status, custo_milesimos, economia_milesimos, criado_em)
        VALUES (?, ?, ?, 'servico', 'enviado', 0, 35, ?)`).run(empresa.id, r.id, contatoId, agora());
      db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, status, criada_em)
        VALUES (?, ?, 'saida', 'sistema', 'texto', 'Sua fatura vence em 3 dias.', 'wa-regua-1', 'servico', 0, 'entregue', ?)`)
        .run(conversa, empresa.id, agora());

      const d = custo.resumo(db, empresa.id, { de: hoje(), ate: hoje() });
      // A mensagem nova é de serviço, mas a economia é da régua: o bloco da janela
      // espontânea não pode crescer, senão o mesmo R$ 0,035 apareceria duas vezes.
      assert.equal(d.economia.por_janela_de_servico.milesimos, antes.economia.por_janela_de_servico.milesimos,
        'a janela espontânea não absorve o disparo da régua');
      assert.equal(d.economia.pela_regua.pela_janela, 1);
      assert.equal(d.economia.pela_regua.pela_janela_milesimos, 35);
      assert.equal(d.economia.pela_regua.pulados_milesimos, 0);
      // E a soma dos três blocos da tela tem de dar exatamente a economia total.
      assert.equal(
        d.economia.por_janela_de_servico.milesimos
        + d.economia.pela_regua.pela_janela_milesimos
        + d.economia.pela_regua.pulados_milesimos,
        d.economia_milesimos,
      );
      assert.equal(d.gasto_milesimos + d.economia_milesimos, d.sem_otimizacao_milesimos);
    } finally { sem.restaurar(); }
  });
});

/** A régua: cada decisão dela vale o preço de um template. */
describe('régua de cobrança', () => {
  let meta;
  let ixc;
  let ambiente;

  /** Cadastro com N faturas vencendo na data que a régua procura. */
  const comFaturas = (quantos, { venceEm = 3 } = {}) => {
    const vencimento = somarDias(hoje(), venceEm);
    const clientes = [];
    const faturas = [];
    for (let i = 0; i < quantos; i++) {
      const id = String(900 + i);
      clientes.push({ id, razao: `Cliente ${i + 1}`, cnpj_cpf: '123.456.789-09', ativo: 'S', telefone_celular: `(11) 9${String(80000000 + i).slice(0, 8)}` });
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

  beforeEach(() => {
    meta = h.fingirMeta();
    ambiente = h.criarAmbiente();
    h.comIxc(ambiente.db, ambiente.empresa.id);
  });
  afterEach(() => { meta.restaurar(); ixc?.restaurar(); });

  test('simula antes de disparar: quantos, quanto custa e quanto economiza', async () => {
    ixc = h.fingirIxc(comFaturas(10));
    const r = novaRegua(ambiente.db, ambiente.empresa.id);
    const s = await regua.simular(ambiente.db, ambiente.empresa, r);
    assert.equal(s.alcancaveis, 10);
    assert.equal(s.por_template, 10, 'ninguém tem janela aberta ainda');
    assert.equal(s.custo_milesimos, 10 * 35, 'R$ 0,35 no total');
    assert.equal(s.sem_otimizacao_milesimos, 10 * 35);
    assert.equal(s.data_alvo, somarDias(hoje(), 3));
  });

  test('quem está com a janela aberta recebe de graça, como serviço', async () => {
    const { db, empresa } = ambiente;
    const cadastro = comFaturas(3);
    ixc = h.fingirIxc(cadastro);
    // O primeiro cliente mandou mensagem agora: a janela dele está aberta.
    const telefone = '5511980000000';
    cadastro.clientes[0].telefone_celular = '(11) 98000-0000';
    const contato = conversas.garantirContato(db, empresa.id, telefone, 'Cliente 1');
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
    const conversa = conversas.abrir(db, { empresa, numero, contato });
    conversas.tocarJanela(db, conversa);

    const r = novaRegua(db, empresa.id);
    const s = await regua.simular(db, empresa, r);
    assert.equal(s.pela_janela, 1, 'um vai pela janela');
    assert.equal(s.por_template, 2);
    assert.equal(s.custo_milesimos, 2 * 35, 'só os dois templates custam');
    assert.equal(s.economia_milesimos, 35, 'o da janela economizou um template');

    const exec = await regua.executar(db, empresa, r);
    assert.equal(exec.enviados, 3);
    assert.equal(exec.pela_janela, 1);
    assert.equal(exec.custo_milesimos, 70);
    assert.equal(exec.economia_milesimos, 35);
    const pelaJanela = db.prepare("SELECT categoria, custo_milesimos FROM mensagens WHERE conversa_id = ? AND tipo = 'texto' ORDER BY id DESC LIMIT 1").get(conversa.id);
    assert.equal(pelaJanela.categoria, 'servico');
    assert.equal(pelaJanela.custo_milesimos, 0);
  });

  test('não cobra quem pagou entre a consulta e o disparo', async () => {
    const { db, empresa } = ambiente;
    // Quem já estava pago nem entra na lista. O que a régua protege é o pagamento que cai no meio
    // do disparo: ela reconfere cada fatura no IXC antes de gastar a mensagem.
    ixc = h.fingirIxc(comFaturas(3), { pagasNaConsultaIndividual: ['701'] });
    const r = novaRegua(db, empresa.id);
    const exec = await regua.executar(db, empresa, r);
    assert.equal(exec.enviados, 2);
    assert.equal(exec.pulados, 1);
    assert.equal(exec.economia_milesimos, 35, 'a mensagem que não foi é economia');
    assert.match(db.prepare("SELECT motivo FROM disparos WHERE status = 'pulado'").get().motivo, /já foi paga/);
  });

  test('fatura já paga antes da consulta nem entra na lista', async () => {
    const { db, empresa } = ambiente;
    const cadastro = comFaturas(3);
    cadastro.faturas[1].status = 'R';
    ixc = h.fingirIxc(cadastro);
    const r = novaRegua(db, empresa.id);
    const s = await regua.simular(db, empresa, r);
    assert.equal(s.alcancaveis, 2, 'o IXC só devolve as faturas em aberto');
  });

  test('não atropela quem está em atendimento, nem repete no período, nem insiste em quem pediu para parar', async () => {
    const { db, empresa, atendente } = ambiente;
    const cadastro = comFaturas(3);
    cadastro.clientes[0].telefone_celular = '(11) 98000-0000';
    cadastro.clientes[1].telefone_celular = '(11) 98000-0001';
    cadastro.clientes[2].telefone_celular = '(11) 98000-0002';
    ixc = h.fingirIxc(cadastro);
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);

    // 1: em atendimento com a equipe.
    const emAtendimento = conversas.garantirContato(db, empresa.id, '5511980000000', null);
    const c1 = conversas.abrir(db, { empresa, numero, contato: emAtendimento });
    db.prepare("UPDATE conversas SET estado = 'humano', atendente_id = ? WHERE id = ?").run(atendente.id, c1.id);
    // 2: pediu para não receber mensagem ativa.
    const optOut = conversas.garantirContato(db, empresa.id, '5511980000001', null);
    db.prepare('UPDATE contatos SET aceita_ativo = 0 WHERE id = ?').run(optOut.id);

    const r = novaRegua(db, empresa.id);
    const exec = await regua.executar(db, empresa, r);
    assert.equal(exec.pulados, 2);
    assert.equal(exec.enviados, 1);
    const motivos = db.prepare("SELECT motivo FROM disparos WHERE status = 'pulado'").all().map((x) => x.motivo).join(' | ');
    assert.match(motivos, /em atendimento com a equipe/);
    assert.match(motivos, /não receber mensagens ativas/);

    // Rodar de novo no mesmo dia não manda de novo para quem já recebeu.
    const denovo = await regua.executar(db, empresa, r);
    assert.equal(denovo.enviados, 0);
    assert.match(db.prepare("SELECT motivo FROM disparos WHERE status = 'pulado' ORDER BY id DESC LIMIT 1").get().motivo, /já recebeu esta régua/);
  });

  test('o teto de gasto para a régua antes de estourar', async () => {
    const { db, empresa } = ambiente;
    ixc = h.fingirIxc(comFaturas(10));
    // Teto de R$ 0,10 = 100 milésimos: dá para 2 templates de R$ 0,035.
    const r = novaRegua(db, empresa.id, { teto_milesimos: 100 });
    const exec = await regua.executar(db, empresa, r);
    assert.equal(exec.teto_atingido, true);
    assert.equal(exec.enviados, 2);
    assert.ok(exec.custo_milesimos <= 100);
  });

  test('a régua exige o texto da janela quando vai usar a janela', () => {
    const { db, empresa } = ambiente;
    assert.throws(() => regua.salvar(db, empresa.id, {
      nome: 'Sem texto', template: 'x', preferir_janela: true, texto_janela: '',
    }), /texto livre equivalente/);
  });

  test('os parâmetros do template são preenchidos com os dados do cliente', () => {
    const { db, empresa } = ambiente;
    const r = novaRegua(db, empresa.id);
    const dados = { nome: 'Ana Clara Ribeiro', vencimento: '2026-11-20', valor_centavos: 12990 };
    assert.deepEqual(regua.montarParametros(r, dados), ['Ana', '20/11/2026', 'R$ 129,90'.replace(' ', ' ')]);
    assert.equal(
      regua.preencherTexto(r.texto_janela, dados).replace(/ /g, ' '),
      'Oi Ana! Sua fatura de R$ 129,90 vence em 20/11/2026. Quer que eu mande o PIX?',
    );
  });

  test('a data alvo acompanha o gatilho', () => {
    const { db, empresa } = ambiente;
    const antes = novaRegua(db, empresa.id, { nome: 'Antes', gatilho: 'dias_antes_vencimento', dias: 3 });
    const noDia = novaRegua(db, empresa.id, { nome: 'No dia', gatilho: 'no_vencimento', dias: 0 });
    const depois = novaRegua(db, empresa.id, { nome: 'Depois', gatilho: 'dias_apos_vencimento', dias: 5 });
    assert.equal(regua.dataAlvo(antes), somarDias(hoje(), 3));
    assert.equal(regua.dataAlvo(noDia), hoje());
    assert.equal(regua.dataAlvo(depois), somarDias(hoje(), -5));
  });

  test('só roda na hora e no dia marcados, e uma vez por dia', () => {
    const { db, empresa } = ambiente;
    const r = novaRegua(db, empresa.id, { hora: '09:00', dias_semana: '1111111' });
    // 2026-11-11 12:00 UTC = 09:00 em São Paulo.
    const naHora = new Date('2026-11-11T12:00:00Z');
    assert.equal(regua.devemRodar(db, naHora).some((x) => x.id === r.id), true);
    assert.equal(regua.devemRodar(db, new Date('2026-11-11T15:00:00Z')).some((x) => x.id === r.id), false, 'fora da janela da hora');
    db.prepare('UPDATE reguas SET ultima_execucao_em = ? WHERE id = ?').run('2026-11-11T12:00:00.000Z', r.id);
    assert.equal(regua.devemRodar(db, naHora).some((x) => x.id === r.id), false, 'já rodou hoje');
  });
});
