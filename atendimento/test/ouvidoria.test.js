'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const ouvidoriaLib = require('../server/lib/ouvidoria');
const cliente360 = require('../server/lib/cliente360');
const conversasLib = require('../server/lib/conversas');
const { agora } = require('../server/db');

/** Um cliente com história: 2 anos de casa, paga em dia, mas teve 4 chamados e já reclamou. */
function clienteComHistoria(db, empresa, { meses = 24, mensalidade = 12990, chamados = 4, pontualidade = 'boa' } = {}) {
  const contato = conversasLib.garantirContato(db, empresa.id, h.TELEFONE_CLIENTE, 'Ana Clara');
  db.prepare('UPDATE contatos SET codigo_externo = ?, nome = ? WHERE id = ?').run('501', 'Ana Clara Ribeiro', contato.id);
  const ativado = new Date(Date.now() - meses * 30 * 86_400_000).toISOString().slice(0, 10);
  const faturas = [];
  for (let i = 1; i <= 12; i++) {
    const venc = new Date(Date.now() - i * 30 * 86_400_000).toISOString().slice(0, 10);
    const atraso = pontualidade === 'boa' ? 0 : 12;
    faturas.push({
      id: String(8000 + i), id_cliente: '501', id_contrato: '77', status: 'R',
      data_vencimento: venc, valor_aberto: (mensalidade / 100).toFixed(2), valor: (mensalidade / 100).toFixed(2),
      data_pagamento: new Date(Date.parse(`${venc}T12:00:00Z`) + atraso * 86_400_000).toISOString().slice(0, 10),
    });
  }
  const listaChamados = Array.from({ length: chamados }, (_, i) => ({
    id: String(600 + i), id_cliente: '501', protocolo: `C${600 + i}`, titulo: 'Sem conexão',
    status: 'F', data_abertura: new Date(Date.now() - (10 + i * 15) * 86_400_000).toISOString().slice(0, 10),
  }));
  return {
    contato,
    cadastro: {
      clientes: [{ id: '501', razao: 'Ana Clara Ribeiro', cnpj_cpf: '123.456.789-09', data_nascimento: '1990-03-05', ativo: 'S', telefone_celular: '(11) 98888-7777' }],
      contratos: [{ id: '77', id_cliente: '501', contrato: 'Fibra 600 Mega', status: 'A', status_internet: 'A', data_ativacao: ativado, valor: (mensalidade / 100).toFixed(2) }],
      faturas,
      chamados: listaChamados,
      logins: [{ id: '301', id_cliente: '501', login: 'ana', online: 'S', ip: '100.64.0.1' }],
    },
  };
}

describe('ficha 360° e score', () => {
  let meta;
  let ixc;
  afterEach(() => { meta?.restaurar(); ixc?.restaurar(); });
  beforeEach(() => { meta = h.fingirMeta(); });

  test('junta IXC e plataforma, calcula risco, valor e recomendação', async () => {
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id);
    const { contato, cadastro } = clienteComHistoria(db, empresa);
    ixc = h.fingirIxc(cadastro);

    const f = await cliente360.ficha(db, empresa.id, contato.id, { ixcClienteId: '501' });
    assert.equal(f.provedor.disponivel, true);
    assert.equal(f.resumo.plano, 'Fibra 600 Mega');
    assert.equal(f.resumo.tempo_casa_meses, 24);
    assert.equal(f.resumo.mensalidade_centavos, 12990);
    assert.equal(f.resumo.pontualidade, 100, 'pagou as 12 faturas em dia');
    assert.equal(f.resumo.chamados_90_dias >= 2, true);

    // Valor alto: mensalidade boa, 2 anos de casa, sempre em dia.
    assert.equal(f.valor.classe, 'A');
    assert.equal(f.valor.perda_anual_centavos, 12990 * 12);

    // O risco é explicado fator a fator, nunca uma caixa-preta.
    assert.ok(f.risco.fatores.length, 'tem fatores');
    assert.ok(f.risco.fatores.every((x) => x.nome && x.detalhe && x.pontos !== 0));
    assert.ok(f.risco.aumentam.some((x) => x.nome === 'Problemas técnicos recentes'));
    assert.ok(f.risco.reduzem.some((x) => x.nome === 'Cliente novo'), '2 anos de casa reduz o risco');
    assert.ok(f.recomendacao.texto.length > 20);
  });

  test('cliente novo, inadimplente e que já tentou cancelar dá risco alto', async () => {
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id);
    const { contato, cadastro } = clienteComHistoria(db, empresa, { meses: 2, mensalidade: 7990, chamados: 5, pontualidade: 'ruim' });
    // Duas faturas vencidas e um pedido de cancelamento anterior.
    cadastro.faturas.push(
      { id: '9001', id_cliente: '501', id_contrato: '77', status: 'A', data_vencimento: new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 10), valor_aberto: '79.90' },
      { id: '9002', id_cliente: '501', id_contrato: '77', status: 'A', data_vencimento: new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10), valor_aberto: '79.90' },
    );
    ixc = h.fingirIxc(cadastro);
    ouvidoriaLib.abrir(db, { empresa, contato, tipo: 'cancelamento', assunto: 'Pediu cancelamento mês passado' });

    const f = await cliente360.ficha(db, empresa.id, contato.id, { ixcClienteId: '501' });
    assert.equal(f.risco.faixa, 'alto', `risco deu ${f.risco.nota}`);
    assert.ok(f.risco.nota >= 60);
    assert.ok(f.risco.aumentam.some((x) => x.nome === 'Pediu cancelamento antes'));
    assert.ok(f.risco.aumentam.some((x) => x.nome === 'Conta em atraso'));
    assert.ok(f.risco.aumentam.some((x) => x.nome === 'Cliente novo'));
    assert.equal(f.valor.classe, 'C');
    // Inadimplente com risco alto: a recomendação manda tratar o financeiro antes de dar desconto.
    assert.match(f.recomendacao.texto, /financeiro/i);
  });

  test('a linha do tempo junta conversa, pagamento, chamado e ouvidoria em ordem', async () => {
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id);
    const { contato, cadastro } = clienteComHistoria(db, empresa);
    ixc = h.fingirIxc(cadastro);
    const sem = h.semIa();
    await h.conversar(db, 'oi, tudo bem?');
    sem.restaurar();
    ouvidoriaLib.abrir(db, { empresa, contato, tipo: 'reclamacao', assunto: 'Internet caindo à noite' });

    const f = await cliente360.ficha(db, empresa.id, contato.id, { ixcClienteId: '501' });
    const tipos = new Set(f.linha_do_tempo.map((e) => e.tipo));
    for (const esperado of ['conversa', 'ouvidoria', 'pagamento', 'tecnico', 'contrato']) {
      assert.ok(tipos.has(esperado), `falta ${esperado} na linha do tempo`);
    }
    assert.ok(f.linha_do_tempo.some((e) => e.titulo === 'Virou cliente'));
    // Do mais novo para o mais antigo.
    const datas = f.linha_do_tempo.map((e) => e.quando);
    assert.deepEqual(datas, [...datas].sort((a, b) => String(b).localeCompare(String(a))));
  });

  test('sem IXC a ficha sai assim mesmo, marcada como incompleta', async () => {
    const { db, empresa } = h.criarAmbiente();
    const contato = conversasLib.garantirContato(db, empresa.id, h.TELEFONE_CLIENTE, 'Sem IXC');
    const f = await cliente360.ficha(db, empresa.id, contato.id);
    assert.equal(f.provedor.disponivel, false);
    assert.match(f.provedor.motivo, /não configurada/);
    assert.ok(f.risco, 'o score existe mesmo sem o IXC');
    assert.equal(f.resumo.mensalidade_centavos, 0);
    assert.equal(f.valor.classe, 'C');
  });

  test('IXC fora do ar não derruba a ficha', async () => {
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id);
    const contato = conversasLib.garantirContato(db, empresa.id, h.TELEFONE_CLIENTE, 'Ana');
    ixc = h.fingirIxc({}, { falhar: true });
    const f = await cliente360.ficha(db, empresa.id, contato.id, { ixcClienteId: '501' });
    assert.equal(f.provedor.disponivel, false);
    assert.ok(f.provedor.motivo);
    assert.ok(f.risco);
  });
});

describe('ouvidoria', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('abre com protocolo, prioridade alta e prazo; Procon tem prazo mais curto', () => {
    const { db, empresa } = h.criarAmbiente();
    const contato = conversasLib.garantirContato(db, empresa.id, h.TELEFONE_CLIENTE, 'Ana');
    const cancel = ouvidoriaLib.abrir(db, { empresa, contato, tipo: 'cancelamento', assunto: 'Quer cancelar' }).ouvidoria;
    assert.match(cancel.protocolo, /^OUV-\d{6}-\d{4}$/);
    assert.equal(cancel.prioridade, 'alta');
    assert.equal(cancel.status, 'aberta');

    const outro = conversasLib.garantirContato(db, empresa.id, '5511977776666', 'Bruno');
    const procon = ouvidoriaLib.abrir(db, { empresa, contato: outro, tipo: 'procon', assunto: 'Notificação do Procon' }).ouvidoria;
    assert.ok(Date.parse(procon.prazo_em) < Date.parse(cancel.prazo_em), 'Procon tem prazo mais curto');
  });

  test('o mesmo cliente reclamando de novo não vira dois processos', () => {
    const { db, empresa } = h.criarAmbiente();
    const contato = conversasLib.garantirContato(db, empresa.id, h.TELEFONE_CLIENTE, 'Ana');
    const primeiro = ouvidoriaLib.abrir(db, { empresa, contato, tipo: 'cancelamento', assunto: 'Quer cancelar' });
    const segundo = ouvidoriaLib.abrir(db, { empresa, contato, tipo: 'cancelamento', assunto: 'Insistiu' });
    assert.equal(segundo.ja_existia, true);
    assert.equal(segundo.ouvidoria.id, primeiro.ouvidoria.id);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM ouvidoria').get().n), 1);
    // Mas a insistência fica registrada na tratativa.
    const eventos = db.prepare('SELECT texto FROM ouvidoria_eventos WHERE ouvidoria_id = ?').all(primeiro.ouvidoria.id);
    assert.ok(eventos.some((e) => /voltou a falar/.test(e.texto)));
  });

  test('o score fica fotografado na abertura, com o porquê escrito na tratativa', async () => {
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id);
    const { contato, cadastro } = clienteComHistoria(db, empresa, { meses: 2, chamados: 5 });
    const ixc = h.fingirIxc(cadastro);
    try {
      const ficha = await cliente360.ficha(db, empresa.id, contato.id, { ixcClienteId: '501' });
      const { ouvidoria } = ouvidoriaLib.abrir(db, { empresa, contato, tipo: 'cancelamento', assunto: 'Quer cancelar', ficha });
      assert.equal(ouvidoria.risco_na_abertura, ficha.risco.nota);
      assert.equal(ouvidoria.valor_na_abertura, ficha.valor.classe);
      assert.equal(ouvidoria.valor_anual_centavos, ficha.resumo.mensalidade_centavos * 12);
      const abertura = db.prepare("SELECT texto FROM ouvidoria_eventos WHERE ouvidoria_id = ? AND tipo = 'abertura' ORDER BY id DESC LIMIT 1").get(ouvidoria.id);
      assert.match(abertura.texto, /risco \d+\/100/);
      assert.match(abertura.texto, /Pesaram:/);
    } finally { ixc.restaurar(); }
  });

  test('ciclo do caso: assumir, tratar e encerrar dizendo se o cliente ficou', () => {
    const { db, empresa, atendente } = h.criarAmbiente();
    const contato = conversasLib.garantirContato(db, empresa.id, h.TELEFONE_CLIENTE, 'Ana');
    db.prepare('UPDATE contatos SET codigo_externo = ? WHERE id = ?').run('501', contato.id);
    const { ouvidoria } = ouvidoriaLib.abrir(db, { empresa, contato, tipo: 'cancelamento', assunto: 'Quer cancelar', ficha: { risco: { nota: 70, faixa: 'alto', aumentam: [] }, valor: { classe: 'A' }, resumo: { mensalidade_centavos: 12990 }, recomendacao: { texto: 'x' } } });

    const assumida = ouvidoriaLib.assumir(db, empresa.id, ouvidoria.id, atendente);
    assert.equal(assumida.status, 'em_tratativa');
    assert.equal(assumida.responsavel_id, atendente.id);

    ouvidoriaLib.evento(db, ouvidoria.id, { tipo: 'proposta', texto: 'Ofereci upgrade de plano pelo mesmo valor por 6 meses.', usuarioId: atendente.id });

    // Cancelamento exige dizer se reteve: sem isso, não encerra.
    assert.throws(() => ouvidoriaLib.encerrar(db, empresa.id, ouvidoria.id, atendente, { status: 'resolvida', desfecho: 'conversamos' }),
      /foi retido ou não/);

    const fechada = ouvidoriaLib.encerrar(db, empresa.id, ouvidoria.id, atendente, { status: 'resolvida', desfecho: 'Aceitou o upgrade e ficou.', retido: true });
    assert.equal(fechada.status, 'resolvida');
    assert.equal(fechada.retido, 1);
    assert.ok(fechada.resolvida_em);
    const desfecho = db.prepare("SELECT texto FROM ouvidoria_eventos WHERE ouvidoria_id = ? AND tipo = 'desfecho'").get(ouvidoria.id);
    assert.match(desfecho.texto, /cliente RETIDO/);
  });

  test('os indicadores contam retenção e receita salva', () => {
    const { db, empresa, atendente } = h.criarAmbiente();
    const { hoje } = require('../server/lib/datas');
    const abrirEFechar = (telefone, retido, mensalidade) => {
      const c = conversasLib.garantirContato(db, empresa.id, telefone, null);
      const { ouvidoria } = ouvidoriaLib.abrir(db, {
        empresa, contato: c, tipo: 'cancelamento', assunto: 'Cancelamento',
        ficha: { risco: { nota: 50, faixa: 'medio', aumentam: [] }, valor: { classe: 'B' }, resumo: { mensalidade_centavos: mensalidade }, recomendacao: { texto: 'x' } },
      });
      ouvidoriaLib.encerrar(db, empresa.id, ouvidoria.id, atendente, { status: 'resolvida', desfecho: 'ok', retido });
    };
    abrirEFechar('5511900000001', true, 10000);
    abrirEFechar('5511900000002', true, 20000);
    abrirEFechar('5511900000003', false, 15000);

    const i = ouvidoriaLib.indicadores(db, empresa.id, { de: hoje(), ate: hoje() });
    assert.equal(i.cancelamentos, 3);
    assert.equal(i.retidos, 2);
    assert.equal(i.perdidos, 1);
    assert.equal(i.taxa_retencao, 66.7);
    assert.equal(i.receita_salva_centavos, (10000 + 20000) * 12);
    assert.equal(i.receita_perdida_centavos, 15000 * 12);
  });

  test('o prazo estourado marca o caso como atrasado', () => {
    const { db, empresa } = h.criarAmbiente();
    const contato = conversasLib.garantirContato(db, empresa.id, h.TELEFONE_CLIENTE, 'Ana');
    const { ouvidoria } = ouvidoriaLib.abrir(db, { empresa, contato, tipo: 'reclamacao', assunto: 'Reclamação' });
    db.prepare('UPDATE ouvidoria SET prazo_em = ? WHERE id = ?').run(new Date(Date.now() - 3600_000).toISOString(), ouvidoria.id);
    const lista = ouvidoriaLib.listar(db, empresa.id, { status: 'abertas' });
    assert.equal(lista.itens[0].atrasada, true);
    assert.ok(lista.itens[0].horas_para_o_prazo < 0);
  });
});

describe('a atendente virtual e a ouvidoria', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('a IA abre o caso, informa o protocolo e transfere com a ficha', async () => {
    const { db, empresa, atendente } = h.criarAmbiente();
    const ia = h.fingirClaude([
      { texto: 'Poxa, que pena. Posso saber o que aconteceu para você querer cancelar?' },
      { ferramenta: 'abrir_ouvidoria', entrada: { tipo: 'cancelamento', assunto: 'Quer cancelar por quedas constantes à noite', relato: 'O cliente diz que a internet cai toda noite há duas semanas e já perdeu reuniões.' } },
    ]);
    try {
      await h.conversar(db, 'quero cancelar');
      await h.conversar(db, 'cai toda noite, já perdi reunião');
      const o = db.prepare('SELECT * FROM ouvidoria WHERE empresa_id = ?').get(empresa.id);
      assert.ok(o, 'o caso foi aberto');
      assert.equal(o.tipo, 'cancelamento');
      assert.equal(o.origem, 'ia');
      assert.match(o.relato, /cai toda noite/);
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'humano');
      assert.equal(c.atendente_id, atendente.id);
      assert.match(c.motivo_transferencia, new RegExp(o.protocolo));
      assert.match(c.resumo, /Risco \d+\/100/);
    } finally { ia.restaurar(); }
  });

  test('elogio fica registrado e o atendimento continua, sem ocupar ninguém', async () => {
    const { db, empresa } = h.criarAmbiente();
    const ia = h.fingirClaude([
      { ferramenta: 'abrir_ouvidoria', entrada: { tipo: 'elogio', assunto: 'Elogiou a Marina', relato: 'Disse que foi muito bem atendido.' } },
      { texto: 'Que bom! Já registrei seu elogio, obrigado.' },
    ]);
    try {
      await h.conversar(db, 'quero elogiar o atendimento de vocês');
      const o = db.prepare('SELECT * FROM ouvidoria WHERE empresa_id = ?').get(empresa.id);
      assert.equal(o.tipo, 'elogio');
      assert.equal(h.conversaDoCliente(db).estado, 'bot', 'elogio não transfere');
    } finally { ia.restaurar(); }
  });

  test('sem IA, as regras abrem o caso sozinhas: o cancelamento não se perde', async () => {
    const { db, empresa } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'quero cancelar meu contrato');
      const o = db.prepare('SELECT * FROM ouvidoria WHERE empresa_id = ?').get(empresa.id);
      assert.ok(o, 'as regras abriram o caso');
      assert.equal(o.tipo, 'cancelamento');
      assert.match(o.relato, /quero cancelar/);
      const c = h.conversaDoCliente(db);
      assert.equal(c.estado, 'humano');
      assert.match(meta.enviadas.map((m) => m.texto).join(' '), new RegExp(o.protocolo));
    } finally { sem.restaurar(); }
  });

  test('"quero falar com um atendente" continua sendo transferência simples, sem abrir caso', async () => {
    const { db, empresa } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'quero falar com um atendente');
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM ouvidoria WHERE empresa_id = ?').get(empresa.id).n), 0);
      assert.equal(h.conversaDoCliente(db).estado, 'humano');
    } finally { sem.restaurar(); }
  });

  test('Procon pelas regras vira caso formal com prioridade alta', async () => {
    const { db, empresa } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'se não resolverem eu vou no procon');
      const o = db.prepare('SELECT * FROM ouvidoria WHERE empresa_id = ?').get(empresa.id);
      assert.equal(o.tipo, 'procon');
      assert.equal(o.prioridade, 'alta');
    } finally { sem.restaurar(); }
  });
});
