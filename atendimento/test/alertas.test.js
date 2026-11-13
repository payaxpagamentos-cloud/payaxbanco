'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const alertas = require('../server/lib/alertas');
const ferramentas = require('../server/ia/ferramentas');

const daquiAHoras = (n) => new Date(Date.now() + n * 3_600_000).toISOString();

const novoAlerta = (db, empresaId, extra = {}) => alertas.salvar(db, empresaId, {
  titulo: 'Rompimento no Centro',
  mensagem: 'Já identificamos uma falha que afeta a sua região e a equipe técnica está no local.',
  tipo: 'massiva', abrangencia: 'chave', chaves: ['Centro'],
  inicio: daquiAHoras(-1), fim: daquiAHoras(5), ativo: true, ...extra,
});

/** Um cadastro de IXC como ele chega: campos variados, acentuação e caixa do jeito que vierem. */
const CLIENTE_CENTRO = {
  cadastro: { id: '900', razao: 'Ana Souza', bairro: 'CENTRO', cidade: 'Praia Grande' },
  contratos: [{ id: '77', id_cliente: '900' }],
  logins: [{ id: '55', login: 'ana@fibra', id_transmissor: 'OLT-03' }],
};
const CLIENTE_JARDIM = {
  cadastro: { id: '901', razao: 'Bruno Lima', bairro: 'Jardim América', cidade: 'Praia Grande' },
  contratos: [{ id: '78', id_cliente: '901' }],
  logins: [{ id: '56', login: 'bruno@fibra', id_transmissor: 'OLT-07' }],
};

describe('alertas de rede', () => {
  let ambiente;
  beforeEach(() => { ambiente = h.criarAmbiente(); });

  test('só pega quem está na área declarada', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id);
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_CENTRO).length, 1, 'o do Centro é avisado');
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_JARDIM).length, 0, 'o do Jardim não');
  });

  test('a comparação ignora acento e caixa, mas é exata', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id, { chaves: ['jardim america'] });
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_JARDIM).length, 1, '"jardim america" pega "Jardim América"');

    // Exata de propósito: um prefixo faria a ZOE avisar quem está com a internet funcionando.
    const db2 = h.criarAmbiente();
    novoAlerta(db2.db, db2.empresa.id, { chaves: ['Centro'] });
    assert.equal(alertas.paraCliente(db2.db, db2.empresa.id, {
      cadastro: { id: '1', bairro: 'Centro Novo' }, contratos: [], logins: [],
    }).length, 0, '"Centro" não pode pegar "Centro Novo"');
  });

  test('pega pela OLT, que mora no login e não no cadastro do cliente', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id, { titulo: 'OLT-03 fora', chaves: ['OLT-03'] });
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_CENTRO).length, 1);
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_JARDIM).length, 0);
  });

  test('limitar os campos comparados evita casamento por acaso', () => {
    const { db, empresa } = ambiente;
    // Sem limitar, "Praia Grande" pega pela cidade.
    novoAlerta(db, empresa.id, { chaves: ['Praia Grande'] });
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_CENTRO).length, 1);

    const outro = h.criarAmbiente();
    novoAlerta(outro.db, outro.empresa.id, { chaves: ['Praia Grande'], campos: ['bairro'] });
    assert.equal(alertas.paraCliente(outro.db, outro.empresa.id, CLIENTE_CENTRO).length, 0,
      'comparando só o bairro, a cidade não casa');
  });

  test('abrangência por lista de clientes usa o código do cliente e do contrato', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id, { abrangencia: 'clientes', clientes: ['901'], chaves: [] });
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_JARDIM).length, 1);
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_CENTRO).length, 0);

    const porContrato = h.criarAmbiente();
    novoAlerta(porContrato.db, porContrato.empresa.id, { abrangencia: 'clientes', clientes: ['77'], chaves: [] });
    assert.equal(alertas.paraCliente(porContrato.db, porContrato.empresa.id, CLIENTE_CENTRO).length, 1, 'o 77 é o contrato');
  });

  test('sem saber quem é o cliente, só o alerta geral vale', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id);
    novoAlerta(db, empresa.id, { titulo: 'Manutenção geral', abrangencia: 'todos', chaves: [], tipo: 'manutencao' });
    const semCliente = alertas.paraCliente(db, empresa.id, null);
    assert.equal(semCliente.length, 1);
    assert.equal(semCliente[0].abrangencia, 'todos');
  });

  test('fora do período e desligado não valem', () => {
    const { db, empresa } = ambiente;
    const passado = novoAlerta(db, empresa.id, { titulo: 'Ontem', inicio: daquiAHoras(-48), fim: daquiAHoras(-24) });
    const futuro = novoAlerta(db, empresa.id, { titulo: 'Amanhã', inicio: daquiAHoras(24), fim: daquiAHoras(30) });
    const desligado = novoAlerta(db, empresa.id, { titulo: 'Desligado', ativo: false });
    assert.equal(passado.situacao, 'encerrado');
    assert.equal(futuro.situacao, 'agendado');
    assert.equal(desligado.situacao, 'desligado');
    assert.equal(alertas.vigentes(db, empresa.id).length, 0);
    assert.equal(alertas.paraCliente(db, empresa.id, CLIENTE_CENTRO).length, 0);
  });

  test('recusa alerta sem área e com período invertido', () => {
    const { db, empresa } = ambiente;
    assert.throws(() => novoAlerta(db, empresa.id, { chaves: [] }), /pelo menos uma chave/);
    assert.throws(() => novoAlerta(db, empresa.id, { abrangencia: 'clientes', clientes: [], chaves: [] }), /código de cliente/);
    assert.throws(() => novoAlerta(db, empresa.id, { inicio: daquiAHoras(5), fim: daquiAHoras(1) }), /depois do início/);
  });

  test('o alerta de outra empresa não vaza', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id);
    const outra = db.prepare("SELECT id FROM empresas WHERE id <> ? LIMIT 1").get(empresa.id);
    if (outra) assert.equal(alertas.paraCliente(db, outra.id, CLIENTE_CENTRO).length, 0);
  });
});

describe('a nota de estado da conversa', () => {
  const atendente = require('../server/ia/atendente');

  test('entra depois da fala do cliente, mesmo com a saudação da ZOE por último', () => {
    const hist = [
      { role: 'user', content: [{ type: 'text', text: 'minha internet caiu' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Olá! Eu sou a ZOE.' }] },
    ];
    const r = atendente.comEstado(hist, 'NOTA');
    assert.deepEqual(r.map((m) => m.role), ['user', 'system', 'assistant'],
      'a nota some se for só anexada no fim, e é na primeira mensagem que ela mais faz falta');
    assert.equal(r[1].content, 'NOTA');
  });

  test('entra no fim quando a última é do cliente', () => {
    const hist = [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }];
    assert.deepEqual(atendente.comEstado(hist, 'NOTA').map((m) => m.role), ['user', 'system']);
  });

  test('sem nota, ou sem fala do cliente, nada muda', () => {
    const hist = [{ role: 'user', content: [] }];
    assert.equal(atendente.comEstado(hist, null), hist);
    assert.deepEqual(atendente.comEstado([{ role: 'assistant', content: [] }], 'NOTA').map((m) => m.role), ['assistant']);
    assert.deepEqual(atendente.comEstado([], 'NOTA'), []);
  });
});

describe('a ZOE e os alertas', () => {
  let ambiente;
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); ambiente = h.criarAmbiente(); });
  afterEach(() => { meta.restaurar(); });

  test('sem alerta em vigor, a ferramenta nem entra no kit', () => {
    const { db, empresa } = ambiente;
    const kit = ferramentas.montar(db, { empresaId: empresa.id });
    assert.equal(kit.tools.some((t) => t.name === 'alertas_da_regiao'), false,
      'ferramenta que só responderia "não há nada" custa token em toda conversa');
  });

  test('com alerta em vigor, a ferramenta entra', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id);
    const kit = ferramentas.montar(db, { empresaId: empresa.id });
    assert.equal(kit.tools.some((t) => t.name === 'alertas_da_regiao'), true);
    const t = kit.tools.find((x) => x.name === 'alertas_da_regiao');
    assert.match(t.description, /antes de diagnostico_de_conexao/);
  });

  test('sem identidade confirmada a ferramenta só entrega o alerta geral', async () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id);
    novoAlerta(db, empresa.id, { titulo: 'Manutenção geral', abrangencia: 'todos', chaves: [], tipo: 'manutencao' });

    const sem = h.semIa();
    let conversa;
    try {
      await h.conversar(db, 'minha internet caiu');
      conversa = db.prepare('SELECT * FROM conversas ORDER BY id DESC LIMIT 1').get();
    } finally { sem.restaurar(); }

    const kit = ferramentas.montar(db, { empresaId: empresa.id });
    const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);
    const r = await ferramentas.executar('alertas_da_regiao', {}, { db, empresa, conversa, contato, ferramentas: kit });
    assert.equal(r.resultado.identificado, false);
    assert.equal(r.resultado.alertas.length, 1, 'só o geral');
    assert.equal(r.resultado.alertas[0].tipo, 'Manutenção programada');
    assert.match(r.resultado.instrucao, /identifique e confirme a identidade/);
  });

  test('numa conversa de verdade, a ZOE consulta o alerta antes de diagnosticar', async () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id, { abrangencia: 'todos', chaves: [], titulo: 'Falha geral',
      mensagem: 'Estamos com uma instabilidade que afeta vários clientes e a equipe já está tratando.' });

    const iaFalsa = h.fingirIa([
      { ferramenta: 'alertas_da_regiao', entrada: {} },
      { texto: 'Oi! Estamos com uma instabilidade que afeta vários clientes e a equipe já está tratando. '
        + 'Assim que normalizar sua conexão volta sozinha.' },
    ]);
    try {
      await h.conversar(db, 'minha internet está caindo toda hora');
    } finally { iaFalsa.restaurar(); }

    const conversa = db.prepare('SELECT * FROM conversas ORDER BY id DESC LIMIT 1').get();
    const respostas = h.mensagensDe(db, conversa.id).filter((m) => m.direcao === 'saida');
    assert.ok(respostas.some((m) => /instabilidade/.test(m.texto)), 'a ZOE repassou o alerta');

    // A nota de estado mandou conferir: é por isso que ela chamou a ferramenta.
    const pedido = iaFalsa.pedidos.at(0);
    const sistemaNoMeio = (pedido.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content).join(' ');
    // A nota entra logo depois da fala do cliente, mesmo quando a saudação da ZOE veio por último.
    const papeis = (pedido.messages ?? []).map((m) => m.role);
    assert.equal(papeis[papeis.indexOf('system') - 1], 'user', 'a nota de sistema tem de seguir uma mensagem do cliente');
    assert.match(sistemaNoMeio, /alertas_da_regiao ANTES de/);
    assert.equal(alertas.buscar(db, empresa.id, alertas.vigentes(db, empresa.id)[0].id).avisados, 1);
  });

  test('o alerta conta quantas vezes foi usado', () => {
    const { db, empresa } = ambiente;
    const a = novoAlerta(db, empresa.id);
    assert.equal(a.avisados, 0);
    alertas.marcarAvisado(db, [a.id, a.id]);
    assert.equal(alertas.buscar(db, empresa.id, a.id).avisados, 2);
  });

  test('a nota da conversa manda conferir o alerta antes de diagnosticar', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id);
    const conversa = { id: 1, empresa_id: empresa.id };
    const nota = alertas.vigentes(db, empresa.id);
    assert.equal(nota.length, 1);
    const texto = alertas.nota(alertas.paraCliente(db, empresa.id, CLIENTE_CENTRO));
    assert.match(texto, /acima do que o cadastro disser/);
    assert.match(texto, /NÃO abra chamado técnico/);
    assert.ok(conversa.empresa_id);
  });

  test('quando o alerta manda abrir chamado, a instrução muda', () => {
    const { db, empresa } = ambiente;
    novoAlerta(db, empresa.id, { abre_chamado: true });
    const texto = alertas.nota(alertas.paraCliente(db, empresa.id, CLIENTE_CENTRO));
    assert.match(texto, /abra o chamado se o cliente quiser registrar/);
  });
});
