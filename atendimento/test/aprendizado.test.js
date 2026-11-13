'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const aprendizado = require('../server/lib/aprendizado');
const conhecimento = require('../server/ia/conhecimento');

/**
 * O ciclo do aprendizado: a ZOE não resolve → fica registrado por quê → quem atendeu conta como
 * resolveu → a equipe ensina → o próximo caso igual a ZOE resolve sozinha.
 */
describe('o que a ZOE não resolveu vira aprendizado', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => meta.restaurar());

  /** A ZOE com IA transfere dizendo o tema e o que faltou. */
  const transferePelaIa = async (db, texto, telefone, { tema = 'mudança de endereço', por = 'nao_sabia' } = {}) => {
    const ia = h.fingirIa([
      { ferramenta: 'buscar_conhecimento', entrada: { pergunta: texto } },
      { ferramenta: 'transferir_para_humano', entrada: {
        fila: null, motivo: 'Não achei a regra de mudança de endereço.', resumo: 'Cliente vai se mudar e quer levar a internet.',
        tema, por_que_nao_resolvi: por, o_que_faltou: 'A taxa e o prazo da mudança de endereço.' } },
    ]);
    try { await h.conversar(db, texto, { telefone }); } finally { ia.restaurar(); }
    return h.conversaDoCliente(db, telefone);
  };

  test('a transferência da IA registra o tema, o motivo e o que faltou', async () => {
    const { db } = h.criarAmbiente();
    const c = await transferePelaIa(db, 'vou me mudar, como faço para levar a internet?', '5511900000001');
    const l = aprendizado.daConversa(db, c.id);
    assert.equal(l.categoria, 'nao_sabia');
    assert.equal(l.tema, 'mudança de endereço');
    assert.equal(l.tema_chave, 'mudanca endereco');
    assert.match(l.pergunta, /vou me mudar/);
    assert.match(l.o_que_faltou, /taxa e o prazo/);
    assert.equal(l.status, 'aberta');
  });

  test('transferência entre pessoas da equipe não é lacuna da ZOE', () => {
    const { db, empresa, atendente, numero } = h.criarAmbiente();
    const conversas = require('../server/lib/conversas');
    const contato = conversas.garantirContato(db, empresa.id, '5511900000009', 'Teste');
    const c = conversas.abrir(db, { empresa, numero, contato });
    conversas.transferir(db, c, { por: 'humano', usuario: atendente, motivo: 'passando para o financeiro' });
    assert.equal(aprendizado.daConversa(db, c.id), null);
  });

  test('cada caminho de transferência diz o seu motivo', async () => {
    const { db } = h.criarAmbiente();
    const sem = h.semIa();
    try {
      await h.conversar(db, 'quero falar com um atendente', { telefone: '5511900000002' });
      await h.conversar(db, 'atendente', { telefone: '5511900000002' });
      await h.conversar(db, 'quero cancelar meu contrato', { telefone: '5511900000003' });
    } finally { sem.restaurar(); }
    assert.equal(aprendizado.daConversa(db, h.conversaDoCliente(db, '5511900000002').id).categoria, 'cliente_pediu');
    const ouv = aprendizado.daConversa(db, h.conversaDoCliente(db, '5511900000003').id);
    assert.equal(ouv.categoria, 'precisa_de_pessoa', 'cancelamento fica com a equipe por regra');
    assert.equal(ouv.aprende, false);
  });

  test('o ciclo completo: atendente conta como resolveu, a equipe ensina, e a ZOE resolve o próximo', async () => {
    const { db, empresa, atendente } = h.criarAmbiente();
    const c1 = await transferePelaIa(db, 'vou me mudar, como faço para levar a internet?', '5511900000004');
    const c2 = await transferePelaIa(db, 'mudei de casa e quero a internet no endereço novo', '5511900000005', { tema: 'Mudança de endereço' });

    aprendizado.comoResolveu(db, empresa.id, c1.id, atendente, 'Mudança de endereço custa R$ 80 e é feita em até 5 dias úteis. Agenda pelo financeiro.');
    const p = aprendizado.painel(db, empresa.id);
    const tema = p.temas.find((t) => t.tema_chave === 'mudanca endereco');
    assert.equal(tema.casos, 2, '"mudança de endereço" e "Mudança de endereço" são o mesmo tema');
    assert.equal(tema.aprende, true);
    assert.equal(tema.solucoes.length, 1);
    assert.equal(tema.solucoes[0].por, 'Marina Souza');
    assert.equal(tema.perguntas.length, 2, 'as perguntas reais dos clientes');
    assert.equal(p.abertas, 2);

    const r = aprendizado.ensinar(db, empresa.id, {
      tema_chave: 'mudanca endereco', titulo: 'Mudança de endereço',
      resposta: 'A mudança de endereço custa R$ 80 e é feita em até 5 dias úteis.', perguntas: tema.perguntas.join('\n'),
    }, atendente);
    assert.equal(r.lacunas, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM lacunas WHERE status = 'ensinada'").get().n, 2);
    // Da próxima vez, a busca da ZOE acha o artigo com as palavras de um cliente novo.
    const achados = conhecimento.buscar(db, empresa.id, 'vou me mudar e quero levar a internet');
    assert.equal(achados[0]?.titulo, 'Mudança de endereço');
    void c2;
  });

  test('tema que não é para a ZOE pode ser ignorado e sai da lista de pendências', async () => {
    const { db, empresa } = h.criarAmbiente();
    await transferePelaIa(db, 'quero desconto de 50%', '5511900000006', { tema: 'desconto especial', por: 'precisa_de_pessoa' });
    assert.equal(aprendizado.ignorar(db, empresa.id, aprendizado.chaveDoTema('desconto especial')).lacunas, 1);
    assert.equal(aprendizado.painel(db, empresa.id).abertas, 0);
  });

  test('a taxa de resolução da ZOE conta o que ela fechou sozinha contra o que foi para a equipe', () => {
    const { db, empresa, numero } = h.criarAmbiente();
    const conversas = require('../server/lib/conversas');
    const fechar = (tel, transferida, por) => {
      const ct = conversas.garantirContato(db, empresa.id, tel, null);
      const c = conversas.abrir(db, { empresa, numero, contato: ct });
      db.prepare("UPDATE conversas SET estado = 'encerrada', encerrada_em = ?, resolvida_por = ?, transferida_em = ? WHERE id = ?")
        .run(new Date().toISOString(), por, transferida ? new Date().toISOString() : null, c.id);
    };
    fechar('5511911111111', false, 'ia');
    fechar('5511911111112', false, 'ia');
    fechar('5511911111113', false, 'cliente');
    fechar('5511911111114', true, 'humano');
    fechar('5511911111115', false, 'abandono');
    const p = aprendizado.painel(db, empresa.id);
    assert.deepEqual([p.resolucao.zoe, p.resolucao.equipe, p.resolucao.taxa], [3, 1, 75]);
  });
});

describe('aprendizado pelo painel', () => {
  let meta;
  let db;
  let empresa;
  let servidor;
  let base;
  const chamar = async (metodo, caminho, token, corpo) => {
    const r = await fetch(`${base}/api${caminho}`, {
      method: metodo, headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, dados: await r.json() };
  };
  const entrar = async (email) => (await chamar('POST', '/auth/login', null, { email, senha: 'senha12345' })).dados.token;

  before(async () => {
    meta = h.fingirMeta();
    ({ db, empresa } = h.criarAmbiente());
    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;
    const sem = h.semIa();
    try {
      await h.conversar(db, 'qual a senha do wifi do roteador novo?');
      await h.conversar(db, '1');
    } finally { sem.restaurar(); }
  });
  after(async () => { meta.restaurar(); await new Promise((r) => servidor.close(r)); });

  test('sem IA, o cliente que escolhe um time no menu é uma lacuna "não sabia"', () => {
    const c = h.conversaDoCliente(db);
    const l = aprendizado.daConversa(db, c.id);
    assert.equal(l.categoria, 'nao_sabia');
    assert.match(l.tema, /senha do wifi/);
  });

  test('a conversa no painel traz a lacuna, e o atendente conta como resolveu ao encerrar', async () => {
    const token = await entrar('marina@fibramais.com.br');
    const c = h.conversaDoCliente(db);
    db.prepare('UPDATE conversas SET estado = ?, atendente_id = (SELECT id FROM usuarios WHERE email = ?) WHERE id = ?').run('humano', 'marina@fibramais.com.br', c.id);
    const d = await chamar('GET', `/empresas/${empresa.id}/conversas/${c.id}`, token);
    assert.equal(d.dados.lacuna.categoria, 'nao_sabia');
    const r = await chamar('POST', `/empresas/${empresa.id}/conversas/${c.id}/encerrar`, token, {
      como_resolveu: 'A senha vem na etiqueta embaixo do roteador; pelo app dá para trocar.', avisar_cliente: false,
    });
    assert.equal(r.status, 200);
    assert.match(aprendizado.daConversa(db, c.id).solucao, /etiqueta embaixo do roteador/);
  });

  test('o administrador vê o painel e ensina; o atendente não ensina', async () => {
    const admin = await entrar('carlos@fibramais.com.br');
    const p = await chamar('GET', `/empresas/${empresa.id}/ia/aprendizado`, admin);
    assert.equal(p.status, 200);
    const tema = p.dados.temas[0];
    assert.ok(tema.solucoes.length);

    const atendente = await entrar('marina@fibramais.com.br');
    const negado = await chamar('POST', `/empresas/${empresa.id}/ia/aprendizado/ensinar`, atendente, { tema_chave: tema.tema_chave, titulo: 'x', resposta: 'y' });
    assert.equal(negado.status, 403);

    const ok = await chamar('POST', `/empresas/${empresa.id}/ia/aprendizado/ensinar`, admin, {
      tema_chave: tema.tema_chave, titulo: 'Senha do Wi-Fi', resposta: tema.solucoes[0].texto, perguntas: tema.perguntas.join('\n'),
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.dados.lacunas, 1);
    assert.ok(db.prepare("SELECT 1 FROM conhecimento WHERE titulo = 'Senha do Wi-Fi'").get());
  });
});
