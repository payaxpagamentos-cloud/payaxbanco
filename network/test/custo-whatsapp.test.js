'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const h = require('./helpers');
const atendimento = require('../server/conectores/atendimento');

/** Um ZOE Atende de mentira, respondendo o que a API de integração dele responde. */
function fingirAtendimento(resposta) {
  let chaveRecebida = null;
  const s = http.createServer((req, res) => {
    chaveRecebida = req.headers['x-api-key'] ?? null;
    if (!chaveRecebida) { res.writeHead(401).end(JSON.stringify({ erro: 'sem chave' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(typeof resposta === 'function' ? resposta() : resposta));
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${s.address().port}`,
    chave: () => chaveRecebida,
    fechar: () => new Promise((f) => s.close(f)),
  })));
}

const RESPOSTA = {
  empresa: 'Fibra Mais',
  gerado_em: '2026-11-13T12:00:00.000Z',
  moeda: 'BRL',
  precos_milesimos: { servico: 0, utilidade: 35, autenticacao: 30, marketing: 320 },
  mes_corrente: {
    mes: '2026-11', mensagens: 797, por_categoria: [],
    gasto_milesimos: 14_140, economia_milesimos: 21_910, sem_otimizacao_milesimos: 36_050,
    projecao_milesimos: 32_630,
  },
  orcamento: {
    mensal_milesimos: 60_000, marketing_milesimos: 10_000, gasto_milesimos: 14_140,
    restante_milesimos: 45_860, percentual: 23.6, status: 'ok', projecao_estoura: false, avisos: [],
  },
  economia_em_andamento: { avisos_esperando_a_janela: 14, valor_em_risco_milesimos: 490, avisos_salvos_pela_janela: 9 },
  meses: [
    { mes: '2026-11', mensagens: 797, gasto_milesimos: 14_140, economia_milesimos: 21_910, sem_otimizacao_milesimos: 36_050,
      orcamento_milesimos: 60_000, fatura_meta_centavos: null, divergente: null, em_aberto: true, por_categoria: [] },
    { mes: '2026-09', mensagens: 7545, gasto_milesimos: 52_800, economia_milesimos: 68_640, sem_otimizacao_milesimos: 121_440,
      orcamento_milesimos: 60_000, fatura_meta_centavos: 6150, divergente: true, em_aberto: false, por_categoria: [] },
    { mes: '2026-08', mensagens: 5900, gasto_milesimos: 41_300, economia_milesimos: 53_690, sem_otimizacao_milesimos: 94_990,
      orcamento_milesimos: 60_000, fatura_meta_centavos: 4130, divergente: false, em_aberto: false, por_categoria: [] },
  ],
};

describe('custo do WhatsApp no Manager', () => {
  let api;
  let zoe;
  let admin;

  before(async () => {
    api = await h.iniciar();
    zoe = await fingirAtendimento(RESPOSTA);
    admin = await api.login();
  });
  after(async () => { await zoe.fechar(); await api.fechar(); });

  test('sem integração configurada a tela avisa, não quebra', async () => {
    const r = await api.get('/custos/whatsapp', admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.estado, null);
    assert.deepEqual(r.dados.meses, []);
    assert.equal(r.dados.acumulado.meses, 0);
  });

  test('configura, coleta e a gestão vê a conta', async () => {
    const cfg = await api.put('/integracoes/atendimento',
      { config: { url_base: zoe.url, intervalo_s: 900, meses: 12 }, segredo: 'chave-da-empresa', habilitada: true }, admin);
    assert.equal(cfg.status, 200, JSON.stringify(cfg.dados));

    const teste = await api.post('/integracoes/atendimento/testar', {}, admin);
    assert.equal(teste.dados.ok, true, JSON.stringify(teste.dados));
    assert.equal(zoe.chave(), 'chave-da-empresa', 'a chave vai no cabeçalho, não na URL');
    assert.equal(teste.dados.resultado.meses, 3);

    const r = await api.get('/custos/whatsapp', admin);
    assert.equal(r.status, 200);
    // Milésimos de real viram centavos: R$ 141,40 em milésimos = 14140 → 1414 centavos.
    assert.equal(r.dados.estado.gasto_centavos, 1414);
    assert.equal(r.dados.estado.projecao_centavos, 3263);
    assert.equal(r.dados.estado.orcamento_centavos, 6000);
    assert.equal(r.dados.estado.situacao, 'ok');
    assert.equal(r.dados.estado.avisos_esperando, 14);
    assert.equal(r.dados.estado.valor_em_risco_centavos, 49);
    assert.deepEqual(r.dados.estado.precos, { servico: 0, utilidade: 35, autenticacao: 30, marketing: 320 });

    assert.equal(r.dados.meses.length, 3);
    const setembro = r.dados.meses.find((m) => m.mes === '2026-09');
    assert.equal(setembro.gasto_centavos, 5280);
    assert.equal(setembro.fatura_meta_centavos, 6150);
    assert.equal(setembro.diferenca_centavos, 870, 'a Meta cobrou R$ 8,70 a mais');
    assert.equal(setembro.divergente, true);

    // O acumulado só conta mês fechado: o mês em aberto ainda vai mudar.
    assert.equal(r.dados.acumulado.meses, 2);
    assert.equal(r.dados.acumulado.gasto_centavos, 5280 + 4130);
    assert.equal(r.dados.acumulado.conferidos, 2);
    assert.equal(r.dados.acumulado.divergentes, 1);
  });

  test('coletar de novo atualiza o mês em vez de duplicar', async () => {
    await atendimento.coletar(api.db, 1);
    await atendimento.coletar(api.db, 1);
    const r = await api.get('/custos/whatsapp', admin);
    assert.equal(r.dados.meses.length, 3, 'continuam três meses');
  });

  test('cada organização só vê o próprio custo', async () => {
    const outro = await api.outraOrganizacao();
    const r = await api.get('/custos/whatsapp', outro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.estado, null, 'a outra organização não enxerga a conta desta');
    assert.deepEqual(r.dados.meses, []);
  });

  test('resposta fora do formato é recusada, não gravada pela metade', () => {
    assert.throws(() => atendimento.normalizar({ qualquer: 'coisa' }), /Formato inesperado/);
    assert.throws(() => atendimento.normalizar(null), /Formato inesperado/);
    // Mês com nome inválido é descartado em vez de virar linha suja no banco.
    const n = atendimento.normalizar({ ...RESPOSTA, meses: [{ mes: 'sei-la' }, ...RESPOSTA.meses] });
    assert.equal(n.meses.length, 3);
  });
});
