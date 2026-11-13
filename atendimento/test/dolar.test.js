'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const custo = require('../server/lib/custo');
const fechamento = require('../server/lib/fechamento');
const envio = require('../server/lib/envio');
const conversas = require('../server/lib/conversas');
const { agora } = require('../server/db');

/** Conta da Meta cobrada em dólar — a da Connectlink veio assim (US$ 655 em outubro). */
describe('conta da Meta em dólar', () => {
  let db;
  let empresa;
  beforeEach(() => {
    ({ db, empresa } = h.criarAmbiente());
    // R$ 5,50 por dólar, para as contas ficarem redondas.
    db.prepare("UPDATE empresas SET meta_moeda = 'USD', cotacao_x10000 = 55000 WHERE id = ?").run(empresa.id);
  });

  const umaConversa = () => {
    const contato = conversas.garantirContato(db, empresa.id, '5511955550000', 'Cliente');
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
    return conversas.abertaDoContato(db, contato.id) ?? conversas.abrir(db, { empresa, numero, contato });
  };

  test('o preço vem da tabela em dólar, convertido pela cotação do mês', () => {
    // Utilidade US$ 0,0068 × R$ 5,50 = R$ 0,0374 → 37 milésimos.
    assert.equal(custo.preco(db, 'utilidade', empresa.id), 37);
    // Marketing US$ 0,0625 × 5,50 = R$ 0,34375 → 344 milésimos.
    assert.equal(custo.preco(db, 'marketing', empresa.id), 344);
    assert.equal(custo.preco(db, 'servico', empresa.id), 0, 'serviço continua de graça');
  });

  test('empresa em real não muda nada', () => {
    db.prepare("UPDATE empresas SET meta_moeda = 'BRL' WHERE id = ?").run(empresa.id);
    assert.equal(custo.preco(db, 'utilidade', empresa.id), 35);
    assert.equal(custo.custoUsdDe(db, 'utilidade', empresa.id), null);
  });

  test('sem cotação própria, usa a padrão do master', () => {
    db.prepare('UPDATE empresas SET cotacao_x10000 = NULL WHERE id = ?').run(empresa.id);
    const m = custo.moedaDa(db, empresa.id);
    assert.equal(m.cotacao_x10000, 54000);
    assert.equal(m.cotacao_padrao, true);
  });

  test('cada mensagem paga guarda o custo exato em dólar', () => {
    const c = umaConversa();
    db.prepare('UPDATE conversas SET janela_expira_em = NULL WHERE id = ?').run(c.id);
    const id = envio.enfileirar(db, { ...c, janela_expira_em: null }, { autor: 'sistema', tipo: 'template', texto: '[x]', payload: {}, categoriaTemplate: 'utilidade' });
    const m = db.prepare('SELECT categoria, custo_milesimos, custo_usd_micro FROM mensagens WHERE id = ?').get(id);
    assert.equal(m.categoria, 'utilidade');
    assert.equal(m.custo_usd_micro, 6800, 'US$ 0,0068 exato, sem arredondamento de câmbio');
    assert.equal(m.custo_milesimos, 37);
  });

  test('o fechamento confere dólar contra dólar, e mostra o câmbio efetivo', () => {
    const c = umaConversa();
    const mes = fechamento.mesAnterior();
    // 1.000 utilidades no mês passado = US$ 6,80.
    const inserir = db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, custo_usd_micro, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', 'template', '[x]', ?, 'utilidade', 37, 6800, 'entregue', ?)`);
    for (let i = 0; i < 1000; i++) inserir.run(c.id, empresa.id, `wa-usd-${i}`, `${mes}-10T12:00:00.000Z`);

    const f = fechamento.fechar(db, empresa.id, mes);
    assert.equal(f.moeda, 'USD');
    assert.equal(f.gasto_usd_centavos, 680, 'US$ 6,80');
    assert.equal(f.cotacao_x10000, 55000, 'a cotação fica congelada no fechamento');

    // A Meta cobrou US$ 6,80; saiu R$ 38,95 da conta (câmbio + IOF).
    const c2 = fechamento.conferir(db, empresa.id, mes, { valor_usd_centavos: 680, valor_centavos: 3895 });
    assert.equal(c2.diferenca_usd_centavos, 0, 'nossa conta bateu com a fatura, em dólar');
    assert.equal(c2.divergente, false);
    assert.equal(c2.cambio_efetivo, 5.7279, 'o dólar que ficou pago, com IOF e spread');
  });

  test('fatura em dólar acima da nossa conta é divergente — mesmo que o real "feche"', () => {
    const c = umaConversa();
    const mes = fechamento.mesAnterior();
    const inserir = db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, custo_usd_micro, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', 'template', '[x]', ?, 'marketing', 344, 62500, 'entregue', ?)`);
    for (let i = 0; i < 100; i++) inserir.run(c.id, empresa.id, `wa-mkt-${i}`, `${mes}-10T12:00:00.000Z`);
    fechamento.fechar(db, empresa.id, mes);
    const r = fechamento.conferir(db, empresa.id, mes, { valor_usd_centavos: 65500 }); // US$ 655
    assert.equal(r.diferenca_usd_centavos, 65500 - 625, 'contamos US$ 6,25; cobraram US$ 655');
    assert.equal(r.divergente, true);
    assert.equal(r.cambio_efetivo, null, 'sem o valor debitado, não há câmbio efetivo para mostrar');
  });

  test('na conta em dólar, a fatura em dólar é obrigatória', () => {
    const mes = fechamento.mesAnterior();
    fechamento.fechar(db, empresa.id, mes);
    assert.throws(() => fechamento.conferir(db, empresa.id, mes, { valor_centavos: 1000 }), /dólar/);
  });

  test('mensagem de antes da troca para dólar entra pelo preço em dólar, não como zero', () => {
    const c = umaConversa();
    // Uma enviada quando a empresa ainda era em real (sem custo em dólar gravado) e uma depois.
    db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, custo_usd_micro, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', 'template', '[x]', 'wa-antes', 'utilidade', 35, NULL, 'entregue', ?)`).run(c.id, empresa.id, agora());
    db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, custo_usd_micro, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', 'template', '[x]', 'wa-depois', 'utilidade', 37, 6800, 'entregue', ?)`).run(c.id, empresa.id, agora());
    const hojeData = agora().slice(0, 10);
    assert.equal(custo.resumo(db, empresa.id, { de: hojeData, ate: hojeData }).gasto_usd_micro, 2 * 6800);
  });

  test('o resumo do período traz o gasto exato em dólar', () => {
    const c = umaConversa();
    db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, custo_usd_micro, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', 'template', '[x]', 'wa-r-1', 'utilidade', 37, 6800, 'entregue', ?)`).run(c.id, empresa.id, agora());
    const hojeData = agora().slice(0, 10);
    const r = custo.resumo(db, empresa.id, { de: hojeData, ate: hojeData });
    assert.equal(r.moeda, 'USD');
    assert.equal(r.gasto_usd_micro, 6800);
    assert.equal(r.precos_usd_micro.utilidade, 6800);
  });
});
