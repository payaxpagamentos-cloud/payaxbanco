'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const cotacao = require('../server/lib/cotacao');
const custo = require('../server/lib/custo');
const fechamento = require('../server/lib/fechamento');

/** O Banco Central de mentira: devolve os boletins como a API PTAX devolve. */
const bancoCentral = (boletins, { status = 200 } = {}) => {
  const pedidos = [];
  const buscarHttp = async (url) => {
    pedidos.push(url);
    return new Response(JSON.stringify({ value: boletins }), { status, headers: { 'content-type': 'application/json' } });
  };
  return { buscarHttp, pedidos };
};

// Formato real da API (conferido com o Banco Central em 13/11/2026).
const BOLETINS = [
  { cotacaoCompra: 5.4929, cotacaoVenda: 5.4935, dataHoraCotacao: '2026-11-03 13:06:31.943412' },
  { cotacaoCompra: 5.5007, cotacaoVenda: 5.5013, dataHoraCotacao: '2026-11-06 13:06:13.966362' },
  // Sexta → segunda: fim de semana não tem boletim.
  { cotacaoCompra: 5.5140, cotacaoVenda: 5.5146, dataHoraCotacao: '2026-11-09 13:11:19.041465' },
  { cotacaoCompra: 5.6137, cotacaoVenda: 5.6143, dataHoraCotacao: '2026-11-12 13:08:21.000000' },
];

describe('dólar do dia (PTAX do Banco Central)', () => {
  let db;
  let empresa;
  beforeEach(() => {
    ({ db, empresa } = h.criarAmbiente());
    db.prepare("UPDATE empresas SET meta_moeda = 'USD', cotacao_auto = 1, cotacao_x10000 = NULL WHERE id = ?").run(empresa.id);
  });

  test('busca os últimos dias no formato que a API do Banco Central pede', async () => {
    const bc = bancoCentral(BOLETINS);
    const c = await cotacao.atualizar(db, { buscarHttp: bc.buscarHttp, ate: '2026-11-13' });
    assert.match(bc.pedidos[0], /CotacaoDolarPeriodo/);
    assert.match(bc.pedidos[0], /@dataInicial='11-03-2026'/, 'MM-DD-AAAA, dez dias para trás');
    assert.match(bc.pedidos[0], /@dataFinalCotacao='11-13-2026'/);
    assert.equal(c.data, '2026-11-12', 'hoje ainda sem boletim: vale o último dia útil');
    assert.equal(c.venda_x10000, 56143);
    assert.equal(c.boletim_em, '2026-11-12T13:08:21-03:00', 'horário de Brasília marcado como tal');
  });

  test('a conversão passa a usar o dólar do dia', async () => {
    await cotacao.atualizar(db, { buscarHttp: bancoCentral(BOLETINS).buscarHttp, ate: '2026-11-13' });
    const m = custo.moedaDa(db, empresa.id);
    assert.equal(m.fonte, 'ptax');
    assert.equal(m.cotacao_x10000, 56143);
    // Utilidade US$ 0,0068 × R$ 5,6143 = R$ 0,03818 → 38 milésimos.
    assert.equal(custo.preco(db, 'utilidade', empresa.id), 38);
  });

  test('cotação à mão vence o automático quando a empresa desliga', async () => {
    await cotacao.atualizar(db, { buscarHttp: bancoCentral(BOLETINS).buscarHttp, ate: '2026-11-13' });
    db.prepare('UPDATE empresas SET cotacao_auto = 0, cotacao_x10000 = 55000 WHERE id = ?').run(empresa.id);
    const m = custo.moedaDa(db, empresa.id);
    assert.equal(m.fonte, 'manual');
    assert.equal(m.cotacao_x10000, 55000);
  });

  test('sem boletim nenhum ainda, segue com a cotação à mão e depois com a padrão', () => {
    db.prepare('UPDATE empresas SET cotacao_x10000 = 55500 WHERE id = ?').run(empresa.id);
    assert.equal(custo.moedaDa(db, empresa.id).fonte, 'manual');
    db.prepare('UPDATE empresas SET cotacao_x10000 = NULL WHERE id = ?').run(empresa.id);
    const m = custo.moedaDa(db, empresa.id);
    assert.equal(m.fonte, 'padrao');
    assert.equal(m.cotacao_x10000, 54000);
  });

  test('Banco Central fora do ar: dá erro para quem pediu, e o guardado continua valendo', async () => {
    await cotacao.atualizar(db, { buscarHttp: bancoCentral(BOLETINS).buscarHttp, ate: '2026-11-13' });
    await assert.rejects(cotacao.atualizar(db, { buscarHttp: bancoCentral([], { status: 503 }).buscarHttp }), /503/);
    assert.equal(custo.moedaDa(db, empresa.id).cotacao_x10000, 56143);
  });

  test('o mês fecha pela média da PTAX do mês, não pelo dólar do dia do clique', async () => {
    const outubro = [
      { cotacaoCompra: 5.30, cotacaoVenda: 5.30, dataHoraCotacao: '2026-10-01 13:00:00.0' },
      { cotacaoCompra: 5.50, cotacaoVenda: 5.50, dataHoraCotacao: '2026-10-15 13:00:00.0' },
      { cotacaoCompra: 5.70, cotacaoVenda: 5.70, dataHoraCotacao: '2026-10-30 13:00:00.0' },
    ];
    await cotacao.atualizar(db, { buscarHttp: bancoCentral([...outubro, ...BOLETINS]).buscarHttp, ate: '2026-11-13' });
    assert.deepEqual(cotacao.mediaDoMes(db, '2026-10'), { media_x10000: 55000, dias: 3 });
    const f = fechamento.fechar(db, empresa.id, '2026-10');
    assert.equal(f.cotacao_x10000, 55000, 'média de outubro: R$ 5,50 — e não os R$ 5,6143 de hoje');
  });

  test('um boletim intermediário do dia é substituído pelo de fechamento', async () => {
    await cotacao.atualizar(db, { buscarHttp: bancoCentral([
      { cotacaoCompra: 5.60, cotacaoVenda: 5.60, dataHoraCotacao: '2026-11-12 10:00:00.0' },
      { cotacaoCompra: 5.6137, cotacaoVenda: 5.6143, dataHoraCotacao: '2026-11-12 13:08:21.0' },
    ]).buscarHttp, ate: '2026-11-13' });
    assert.equal(cotacao.doDia(db).venda_x10000, 56143);
  });

  test('resposta estranha do Banco Central é ignorada, sem gravar lixo', async () => {
    const c = await cotacao.atualizar(db, { buscarHttp: bancoCentral([{ cotacaoVenda: 0, cotacaoCompra: 0, dataHoraCotacao: '2026-11-12 13:00' }, { foo: 1 }]).buscarHttp });
    assert.equal(c, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM cotacoes').get().n, 0);
  });
});
