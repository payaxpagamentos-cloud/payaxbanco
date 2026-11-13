'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const relatorios = require('../server/lib/relatorios');
const conversas = require('../server/lib/conversas');
const ferramentas = require('../server/ia/ferramentas');
const { hoje } = require('../server/lib/datas');
const { agora } = require('../server/db');

describe('relatórios', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  /** Monta um histórico conhecido: 6 resolvidas pela IA, 3 pela equipe, 1 abandonada. */
  function comHistorico(db, empresa) {
    const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
    const fechar = (telefone, resolvidaPor, { csat = null, transferida = false } = {}) => {
      const contato = conversas.garantirContato(db, empresa.id, telefone, null);
      const c = conversas.abrir(db, { empresa, numero, contato });
      if (transferida) db.prepare('UPDATE conversas SET transferida_em = ?, assumida_em = ? WHERE id = ?').run(agora(), agora(), c.id);
      db.prepare('UPDATE conversas SET estado = ?, resolvida_por = ?, encerrada_em = ?, csat_nota = ? WHERE id = ?')
        .run('encerrada', resolvidaPor, agora(), csat, c.id);
      return c.id;
    };
    for (let i = 0; i < 6; i++) fechar(`551190000${100 + i}`, 'ia', { csat: i < 4 ? 5 : null });
    for (let i = 0; i < 3; i++) fechar(`551190000${200 + i}`, 'humano', { csat: 3, transferida: true });
    fechar('5511900000300', 'abandono');
    return { encerradas: 10 };
  }

  test('a taxa de resolução conta só as conversas encerradas', () => {
    const { db, empresa } = h.criarAmbiente();
    comHistorico(db, empresa);
    const r = relatorios.resumo(db, { empresaId: empresa.id, de: hoje(), ate: hoje() });
    assert.equal(r.conversas, 10);
    assert.equal(r.encerradas, 10);
    assert.equal(r.resolvidas_ia, 6);
    assert.equal(r.resolvidas_humano, 3);
    assert.equal(r.abandonadas, 1);
    assert.equal(r.taxa_resolucao_ia, 60, '6 de 10 encerradas');
    assert.equal(r.transferidas, 3);
    assert.equal(r.taxa_transferencia, 30);
  });

  test('CSAT médio e satisfação só olham quem avaliou', () => {
    const { db, empresa } = h.criarAmbiente();
    comHistorico(db, empresa);
    const r = relatorios.resumo(db, { empresaId: empresa.id, de: hoje(), ate: hoje() });
    assert.equal(r.avaliacoes, 7, '4 notas 5 e 3 notas 3');
    assert.equal(r.csat_medio, Number(((4 * 5 + 3 * 3) / 7).toFixed(2)));
    assert.equal(r.csat_satisfacao, Number(((4 / 7) * 100).toFixed(1)), 'nota 4 ou 5 conta como boa');
  });

  test('sem conversa no período, nada quebra e nada é inventado', () => {
    const { db, empresa } = h.criarAmbiente();
    const r = relatorios.resumo(db, { empresaId: empresa.id, de: '2020-01-01', ate: '2020-01-31' });
    assert.equal(r.conversas, 0);
    assert.equal(r.taxa_resolucao_ia, 0);
    assert.equal(r.csat_medio, null);
    assert.equal(r.csat_satisfacao, null);
    assert.equal(r.primeira_resposta_s, null);
  });

  test('o custo da IA sai dos tokens gravados e do preço cadastrado', () => {
    const { db, empresa } = h.criarAmbiente();
    db.prepare(`INSERT INTO ia_eventos (empresa_id, tipo, nome, tokens_entrada, tokens_saida, tokens_cache, ms, criado_em)
      VALUES (?, 'resposta', 'claude-opus-5-5', 1000000, 100000, 500000, 2000, ?)`).run(empresa.id, agora());
    const c = relatorios.custoIa(db, { empresaId: empresa.id, de: hoje(), ate: hoje() });
    assert.equal(c.tokens_entrada, 1_000_000);
    // 1 milhão de entrada (2160) + 0,1 milhão de saída (1080) + 0,5 milhão de cache (54) = 3294 centavos.
    assert.equal(c.custo_centavos, 2160 + 1080 + 54);
    assert.equal(c.respostas, 1);
  });

  test('o CSV traz uma linha por conversa, com o motivo da transferência', () => {
    const { db, empresa } = h.criarAmbiente();
    comHistorico(db, empresa);
    const csv = relatorios.csvConversas(db, { empresaId: empresa.id, de: hoje(), ate: hoje() });
    const linhas = csv.split('\n');
    assert.equal(linhas.length, 11, 'cabeçalho + 10 conversas');
    assert.match(linhas[0], /^id;aberta_em;encerrada_em;telefone/);
    assert.equal(linhas[1].split(';').length, 14);
  });

  test('o painel do master soma as empresas sem misturar os dados', () => {
    const { db, empresa } = h.criarAmbiente();
    comHistorico(db, empresa);
    const segunda = require('../server/lib/empresas').criar(db, { nome: 'Segunda' }, { comExemplos: false });
    const p = relatorios.painelMaster(db);
    assert.equal(p.totais.empresas_ativas, 2);
    const linhaFibra = p.empresas.find((e) => e.nome === 'Fibra Mais');
    const linhaSegunda = p.empresas.find((e) => e.nome === 'Segunda');
    assert.equal(Number(linhaFibra.conversas_mes), 10);
    assert.equal(Number(linhaSegunda.conversas_mes), 0);
    void segunda;
  });
});

describe('segurança da ZOE', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('a ferramenta da empresa recebe a identificação do nosso banco, não do modelo', async () => {
    const { db, empresa } = h.criarAmbiente();
    let recebido = null;
    const originalFetch = global.fetch;
    global.fetch = async (url, opcoes) => {
      if (String(url).includes('api.cliente')) {
        recebido = JSON.parse(opcoes.body);
        return new Response(JSON.stringify({ faturas: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(url, opcoes);
    };
    try {
      const contato = conversas.garantirContato(db, empresa.id, '5511988887777', 'Ana');
      db.prepare("UPDATE contatos SET documento = '12345678909', codigo_externo = 'ERP-1' WHERE id = ?").run(contato.id);
      const f = {
        id: 1, nome: 'consultar_fatura', metodo: 'POST', url: 'http://api.cliente/faturas', timeout_ms: 5000, cabecalhos_cifrados: null,
      };
      // O modelo tenta se passar por outro cliente nos parâmetros.
      await ferramentas.executarExterna(f, {
        contato: db.prepare('SELECT * FROM contatos WHERE id = ?').get(contato.id),
        conversa: { id: 1 },
        entrada: { mes: '2026-11', telefone: '5511000000000', documento: '00000000000' },
      });
      assert.equal(recebido.contato.telefone, '5511988887777', 'o telefone vem do banco');
      assert.equal(recebido.contato.documento, '12345678909', 'o documento vem do banco');
      assert.equal(recebido.contato.codigo_externo, 'ERP-1');
      // O que o modelo mandou fica à parte, fora do bloco de identificação.
      assert.equal(recebido.telefone, '5511000000000');
      assert.equal(recebido.mes, '2026-11');
    } finally { global.fetch = originalFetch; }
  });

  test('contato bloqueado não é atendido', async () => {
    const { db, empresa } = h.criarAmbiente();
    const ia = h.fingirClaude([{ texto: 'não deveria responder' }]);
    try {
      const contato = conversas.garantirContato(db, empresa.id, h.TELEFONE_CLIENTE, null);
      db.prepare('UPDATE contatos SET bloqueado = 1 WHERE id = ?').run(contato.id);
      await h.conversar(db, 'oi');
      assert.equal(ia.pedidos.length, 0);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE direcao = 'saida' AND tipo <> 'sistema'").get().n), 0,
        'nada foi respondido ao contato bloqueado');
    } finally { ia.restaurar(); }
  });

  test('a ferramenta de transferir some quando a empresa não tem fila', () => {
    const { db, empresa } = h.criarAmbiente();
    db.prepare('UPDATE ia_config SET fila_padrao_id = NULL WHERE empresa_id = ?').run(empresa.id);
    db.prepare('DELETE FROM filas WHERE empresa_id = ?').run(empresa.id);
    const kit = ferramentas.montar(db, { empresaId: empresa.id, semTransferencia: true });
    assert.equal(kit.tools.some((t) => t.name === 'transferir_para_humano'), false);
    assert.equal(kit.tools.some((t) => t.name === 'abrir_chamado'), true, 'ainda dá para registrar o pedido');
  });

  test('toda ferramenta tem schema estrito, como a Claude API exige', () => {
    const { db, empresa } = h.criarAmbiente();
    for (const t of ferramentas.montar(db, { empresaId: empresa.id }).tools) {
      assert.equal(t.strict, true, `${t.name} precisa de strict`);
      assert.equal(t.input_schema.additionalProperties, false, `${t.name} precisa recusar campos extras`);
      assert.deepEqual(t.input_schema.required.sort(), Object.keys(t.input_schema.properties).sort(),
        `${t.name}: em strict, todo campo declarado entra em required`);
    }
  });

  test('o protocolo do chamado não se repete', () => {
    const { db, empresa } = h.criarAmbiente();
    const contato = conversas.garantirContato(db, empresa.id, '5511900000400', null);
    const vistos = new Set();
    for (let i = 0; i < 20; i++) {
      const p = ferramentas.gerarProtocolo(db, empresa.id);
      assert.equal(vistos.has(p), false, `protocolo repetido: ${p}`);
      vistos.add(p);
      db.prepare("INSERT INTO chamados (empresa_id, contato_id, protocolo, assunto, criado_em) VALUES (?, ?, ?, 'teste', ?)")
        .run(empresa.id, contato.id, p, agora());
    }
  });
});
