'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ura = require('../server/lib/ura');

const URA = {
  id: 1, nome: 'Principal', mensagem: 'Digite 1 para suporte, 2 para financeiro.',
  tipo: 'inteligente', situacoes: {}, fila_padrao_id: 7, tecla_atendente: '0', max_tentativas: 3,
  opcoes: [{ digito: '1', destino_tipo: 'fila', destino_id: 7 }, { digito: '2', destino_tipo: 'fila', destino_id: 8 }],
};
const HOJE = '2026-11-13';

describe('a URA descobre a situação do cliente', () => {
  test('contrato bloqueado por atraso vem antes de fatura vencida', () => {
    const s = ura.detectar({
      contratos: [{ id: '1', acesso: 'bloqueio_automatico' }],
      faturas: [{ id: '70', vencimento: '2026-11-01', valor_centavos: 12990 }],
    }, { hoje: HOJE });
    assert.deepEqual(s.map((x) => x.chave), ['bloqueado', 'fatura_vencida']);
  });

  test('falha na região vem antes de tudo', () => {
    const s = ura.detectar({
      alertas: [{ mensagem: 'Rompimento no Centro.' }],
      contratos: [{ id: '1', acesso: 'bloqueio_automatico' }],
    }, { hoje: HOJE });
    assert.equal(s[0].chave, 'massiva');
  });

  test('fatura a vencer só conta dentro do prazo de aviso', () => {
    const perto = ura.detectar({ faturas: [{ id: '1', vencimento: '2026-11-16' }] }, { hoje: HOJE, diasAviso: 5 });
    const longe = ura.detectar({ faturas: [{ id: '1', vencimento: '2026-11-30' }] }, { hoje: HOJE, diasAviso: 5 });
    assert.deepEqual(perto.map((x) => x.chave), ['fatura_a_vencer']);
    assert.deepEqual(longe.map((x) => x.chave), [], 'fatura de daqui a 17 dias não é motivo de ligação');
  });

  test('vencida e a vencer não aparecem juntas: a vencida manda', () => {
    const s = ura.detectar({ faturas: [
      { id: '1', vencimento: '2026-11-01' },
      { id: '2', vencimento: '2026-11-15' },
    ] }, { hoje: HOJE });
    assert.deepEqual(s.map((x) => x.chave), ['fatura_vencida']);
  });

  test('só diz que está sem conexão quando TODOS os logins estão offline', () => {
    const todos = ura.detectar({ logins: [{ online: false }, { online: false }] }, { hoje: HOJE });
    const parte = ura.detectar({ logins: [{ online: false }, { online: true }] }, { hoje: HOJE });
    assert.deepEqual(todos.map((x) => x.chave), ['sem_conexao']);
    assert.deepEqual(parte.map((x) => x.chave), [], 'com um login online, a casa tem internet');
  });

  test('cliente sem nada pendente não gera situação nenhuma', () => {
    assert.deepEqual(ura.detectar({ contratos: [{ id: '1', acesso: 'liberado' }], faturas: [] }, { hoje: HOJE }), []);
  });
});

describe('antes de confirmar a identidade, a URA não entrega o contrato', () => {
  test('não diz que está bloqueado só porque reconheceu o número', () => {
    const r = ura.abertura(URA, { identificado: true, situacoes: [{ chave: 'bloqueado' }] });
    assert.equal(r.fase, 'confirmar');
    assert.doesNotMatch(r.fala, /suspenso|bloquead|fatura|dívida/i,
      'Bina se falsifica: quem está com o telefone de outra pessoa não pode descobrir a situação dela');
    assert.match(r.fala, /três primeiros números do CPF/);
  });

  test('não diz valor nem vencimento antes de confirmar', () => {
    const r = ura.abertura(URA, { identificado: true, situacoes: [{ chave: 'fatura_vencida' }] });
    assert.equal(r.fase, 'confirmar');
    assert.doesNotMatch(r.fala, /R\$|vencimento|vencida/i);
  });

  test('falha na região pode ser dita de cara: é da rede, não do contrato', () => {
    const r = ura.abertura(URA, { identificado: true, situacoes: [{ chave: 'massiva' }] });
    assert.equal(r.fase, 'informar');
    assert.match(r.fala, /falha que afeta a sua região/);
    assert.equal(r.evita_fila, true, 'não vira mais um chamado do mesmo problema');
  });

  test('número desconhecido ouve o menu normal', () => {
    const r = ura.abertura(URA, { identificado: false, situacoes: [] });
    assert.equal(r.fase, 'menu');
    assert.equal(r.fala, URA.mensagem);
  });

  test('a tecla do atendente existe em toda abertura', () => {
    for (const caso of [
      { identificado: false, situacoes: [] },
      { identificado: true, situacoes: [] },
      { identificado: true, situacoes: [{ chave: 'massiva' }] },
      { identificado: true, situacoes: [{ chave: 'bloqueado' }] },
    ]) {
      const r = ura.abertura(URA, caso);
      assert.ok(r.opcoes.some((o) => o.digito === URA.tecla_atendente && o.acao === 'fila'),
        'nenhuma URA pode prender o cliente sem saída para uma pessoa');
    }
  });
});

describe('depois de confirmar, a URA resolve em vez de encaminhar', () => {
  test('bloqueado ouve a oferta de desbloqueio antes de qualquer menu', () => {
    const r = ura.aposConfirmar(URA, { situacoes: [{ chave: 'bloqueado' }], primeiroNome: 'Ana' });
    assert.equal(r.fase, 'oferta');
    assert.equal(r.situacao, 'bloqueado');
    assert.match(r.fala, /^Oi, Ana!/);
    assert.match(r.fala, /acesso está suspenso/);
    assert.equal(r.opcoes[0].acao, 'desbloqueio');
    assert.ok(r.opcoes.some((o) => o.acao === 'menu'), 'sempre dá para ouvir as outras opções');
  });

  test('fatura vencida oferece a segunda via', () => {
    const r = ura.aposConfirmar(URA, { situacoes: [{ chave: 'fatura_vencida' }] });
    assert.equal(r.opcoes[0].acao, 'segunda_via');
  });

  test('sem pendência, vai direto ao menu curto', () => {
    const r = ura.aposConfirmar(URA, { situacoes: [], primeiroNome: 'Ana' });
    assert.equal(r.fase, 'menu');
    assert.match(r.fala, /^Oi, Ana!/);
  });

  test('as outras situações ficam guardadas para depois', () => {
    const r = ura.aposConfirmar(URA, { situacoes: [{ chave: 'bloqueado' }, { chave: 'fatura_vencida' }] });
    assert.equal(r.situacao, 'bloqueado');
    assert.deepEqual(r.tambem.map((x) => x.situacao), ['fatura_vencida'],
      'resolvido o bloqueio, ainda dá para oferecer a segunda via na mesma ligação');
  });

  test('situação desligada pelo provedor não aparece', () => {
    const semDesbloqueio = { ...URA, situacoes: { bloqueado: { ativa: 0, fala: 'x' } } };
    const r = ura.aposConfirmar(semDesbloqueio, { situacoes: [{ chave: 'bloqueado' }, { chave: 'fatura_vencida' }] });
    assert.equal(r.situacao, 'fatura_vencida');
  });

  test('a fala reescrita pelo provedor é a que sai', () => {
    const minha = { ...URA, situacoes: { bloqueado: { ativa: 1, fala: 'Seu plano está pausado por pendência financeira.' } } };
    const r = ura.aposConfirmar(minha, { situacoes: [{ chave: 'bloqueado' }] });
    assert.equal(r.fala, 'Seu plano está pausado por pendência financeira.');
  });
});

describe('o catálogo', () => {
  test('vem ordenado por urgência e com a fala padrão', () => {
    const c = ura.catalogo();
    assert.deepEqual(c.map((x) => x.chave), ['massiva', 'bloqueado', 'fatura_vencida', 'fatura_a_vencer', 'sem_conexao']);
    assert.ok(c.every((x) => x.ativa && x.fala));
  });

  test('só a falha na região pode falar antes da confirmação', () => {
    const antes = ura.catalogo().filter((x) => x.antes_de_confirmar).map((x) => x.chave);
    assert.deepEqual(antes, ['massiva']);
  });
});

describe('a URA no ar, com o IXC respondendo', () => {
  const ixcFalso = (dados) => ({
    clientesPorTelefone: async () => dados.clientes ?? [],
    clientePorId: async (id) => (dados.clientes ?? []).find((c) => String(c.id) === String(id)) ?? null,
    contratos: async () => dados.contratos ?? [],
    faturasAbertas: async () => dados.faturas ?? [],
    logins: async () => dados.logins ?? [],
  });
  const atend = require('../server/lib/ura-atendimento');
  // Banco de verdade para a amarração ligação ↔ cliente (empresa 1, URA 1).
  process.env.NODE_ENV = 'test';
  const db = require('../server/db').abrir(':memory:');
  db.prepare("INSERT INTO empresas (id, nome, criada_em) VALUES (1, 'Provedor', 'x')").run();
  db.prepare("INSERT INTO uras (id, empresa_id, nome, mensagem, tipo, criada_em) VALUES (1, 1, 'Principal', 'Oi', 'inteligente', 'x')").run();
  const ANA = { id: '900', razao: 'Ana Souza', cnpj_cpf: '529.982.247-25' };

  test('número reconhecido com contrato bloqueado: pede confirmação sem entregar nada', async () => {
    const r = await atend.atender(db, { id: 1 }, URA, {
      telefone: '11988887777', uid: 'u-1',
      ixc: ixcFalso({ clientes: [ANA], contratos: [{ id: '1', acesso: 'bloqueio_automatico' }] }),
    });
    assert.equal(r.identificado, true);
    assert.equal(r.cliente_id, '900');
    assert.deepEqual(r.situacoes, ['bloqueado']);
    assert.equal(r.fase, 'confirmar');
    assert.doesNotMatch(r.fala, /suspenso|Ana/, 'nem o nome sai antes de confirmar');
  });

  test('sem o uid da ligação não há como confirmar depois: segue como desconhecido', async () => {
    const r = await atend.atender(db, { id: 1 }, URA, { telefone: '11988887777', ixc: ixcFalso({ clientes: [ANA] }) });
    assert.equal(r.identificado, false);
    assert.equal(r.fase, 'menu');
  });

  test('a confirmação é conferida no servidor, contra o cliente amarrado ao uid', async () => {
    const ixc = ixcFalso({ clientes: [ANA], contratos: [{ id: '1', acesso: 'bloqueio_automatico' }] });
    await atend.atender(db, { id: 1 }, URA, { telefone: '11988887777', uid: 'u-2', ixc });
    // Ligação que a URA não reconheceu: a central não pode inventar o cliente.
    await assert.rejects(atend.confirmar(db, { id: 1 }, URA, { uid: 'nao-existe', codigo: '529', ixc }), /não foi reconhecida/);
    const errado = await atend.confirmar(db, { id: 1 }, URA, { uid: 'u-2', codigo: '111', ixc });
    assert.equal(errado.confirmado, false);
    assert.equal(errado.fase, 'confirmar');
    assert.equal(errado.tentativas_restantes, 2);
    assert.doesNotMatch(JSON.stringify(errado), /Ana|suspenso/, 'código errado não entrega nada');
    const certo = await atend.confirmar(db, { id: 1 }, URA, { uid: 'u-2', codigo: '529', ixc });
    assert.equal(certo.confirmado, true);
    assert.equal(certo.fase, 'oferta');
    assert.match(certo.fala, /^Oi, Ana!/);
  });

  test('três códigos errados: vai para o atendente e não aceita mais tentativa', async () => {
    const ixc = ixcFalso({ clientes: [ANA] });
    await atend.atender(db, { id: 1 }, URA, { telefone: '11988887777', uid: 'u-3', ixc });
    assert.equal((await atend.confirmar(db, { id: 1 }, URA, { uid: 'u-3', codigo: '000', ixc })).fase, 'confirmar');
    assert.equal((await atend.confirmar(db, { id: 1 }, URA, { uid: 'u-3', codigo: '000', ixc })).fase, 'confirmar');
    const terceiro = await atend.confirmar(db, { id: 1 }, URA, { uid: 'u-3', codigo: '000', ixc });
    assert.equal(terceiro.fase, 'fila');
    assert.equal(terceiro.destino_id, URA.fila_padrao_id);
    // Nem o código certo vale depois do limite.
    const depois = await atend.confirmar(db, { id: 1 }, URA, { uid: 'u-3', codigo: '529', ixc });
    assert.equal(depois.confirmado, false);
    assert.equal(depois.fase, 'fila');
  });

  test('depois de confirmar, abre com a oferta de desbloqueio e o primeiro nome', async () => {
    const r = await atend.aposConfirmar(null, { id: 1 }, URA, {
      clienteId: '900',
      ixc: ixcFalso({ clientes: [{ id: '900', razao: 'Ana Souza Lima' }], contratos: [{ id: '1', acesso: 'bloqueio_automatico' }] }),
    });
    assert.equal(r.fase, 'oferta');
    assert.match(r.fala, /^Oi, Ana!/);
    assert.equal(r.opcoes[0].acao, 'desbloqueio');
  });

  test('dois cadastros no mesmo telefone: não adivinha de quem é a ligação', async () => {
    const r = await atend.atender(null, { id: 1 }, URA, {
      telefone: '11988887777',
      ixc: ixcFalso({ clientes: [{ id: '900' }, { id: '901' }] }),
    });
    assert.equal(r.identificado, false);
    assert.equal(r.fase, 'menu');
  });

  test('IXC fora do ar não derruba a ligação: cai no menu normal', async () => {
    const quebrado = { clientesPorTelefone: async () => { throw new Error('timeout'); } };
    const r = await atend.atender(null, { id: 1 }, URA, { telefone: '11988887777', ixc: quebrado });
    assert.equal(r.identificado, false);
    assert.equal(r.fase, 'menu');
    assert.ok(r.opcoes.some((o) => o.acao === 'fila'), 'sempre sobra o caminho para uma pessoa');
  });

  test('URA clássica ignora o IXC', async () => {
    const r = await atend.atender(null, { id: 1 }, { ...URA, tipo: 'classica' }, {
      telefone: '11988887777', ixc: ixcFalso({ clientes: [{ id: '900' }], contratos: [{ id: '1', acesso: 'bloqueio_automatico' }] }),
    });
    assert.equal(r.identificado, false);
    assert.equal(r.fala, URA.mensagem);
  });

  test('um recurso do IXC que falha não leva os outros junto', async () => {
    const meio = {
      clientesPorTelefone: async () => [{ id: '900', razao: 'Ana' }],
      clientePorId: async () => ({ id: '900', razao: 'Ana' }),
      contratos: async () => { throw new Error('indisponível'); },
      faturasAbertas: async () => [{ id: '70', vencimento: '2000-01-01' }],
      logins: async () => [],
    };
    const r = await atend.aposConfirmar(null, { id: 1 }, URA, { clienteId: '900', ixc: meio });
    assert.deepEqual(r.situacoes, ['fatura_vencida'], 'o que deu para ler continua valendo');
  });

  test('o alerta de rede vem do ZOE Atende, não de uma cópia local', async () => {
    let pedido = null;
    const alertas = await atend.alertasDoCliente(
      { alertas_url: 'https://zoe.exemplo/atendimento', alertas_chave: 'atd_x' },
      { clienteId: '900' },
      { buscar: async (url, op) => { pedido = { url, chave: op.headers['X-Api-Key'] }; return new Response(JSON.stringify({ alertas: [{ mensagem: 'Falha no Centro.' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } },
    );
    assert.equal(alertas.length, 1);
    assert.match(pedido.url, /\/api\/integracao\/alertas\?cliente=900$/);
    assert.equal(pedido.chave, 'atd_x');
  });

  test('ZOE Atende fora do ar: a URA segue sem o alerta, sem quebrar', async () => {
    const alertas = await atend.alertasDoCliente(
      { alertas_url: 'https://zoe.exemplo', alertas_chave: 'x' }, { clienteId: '900' },
      { buscar: async () => { throw new Error('rede'); } },
    );
    assert.deepEqual(alertas, []);
  });

  test('sem endereço configurado, nem tenta a rede', async () => {
    let chamou = false;
    const alertas = await atend.alertasDoCliente({}, { clienteId: '900' }, { buscar: async () => { chamou = true; } });
    assert.deepEqual(alertas, []);
    assert.equal(chamou, false);
  });
});
