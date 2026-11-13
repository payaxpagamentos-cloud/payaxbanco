'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const empresasLib = require('../server/lib/empresas');
const passagem = require('../server/lib/passagem');
const voz = require('../server/lib/voz');
const { encerrarLigacoesEsquecidas } = require('../server/lib/manutencao');

/**
 * A passagem de bastão: a ligação sai da ZOE, toca num ramal, e quem atende já sabe quem é o
 * cliente, o que ele quer e o que a ZOE já fez — sem perguntar tudo de novo.
 */
describe('passagem da ligação para o atendente', () => {
  let meta;
  let db;
  let empresa;
  let atendente;
  let servidor;
  let base;
  let chave;

  const integracao = async (caminho, corpo) => {
    const r = await fetch(`${base}/api/integracao${caminho}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': chave }, body: JSON.stringify(corpo ?? {}),
    });
    return { status: r.status, dados: await r.json() };
  };
  const painel = async (metodo, caminho, token, corpo) => {
    const r = await fetch(`${base}/api${caminho}`, {
      method: metodo,
      headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, dados: await r.json() };
  };
  const entrar = async (email) => (await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha: 'senha12345' }),
  })).json()).token;

  /** Uma ligação que conversou com a ZOE e foi transferida. */
  const ligacaoTransferida = async (uid, telefone) => {
    await integracao('/voz/ligacoes', { uid, telefone });
    const sem = h.semIa();
    let r;
    try {
      await integracao(`/voz/ligacoes/${uid}/turno`, { texto: 'minha internet está caindo toda hora desde ontem' });
      r = await integracao(`/voz/ligacoes/${uid}/turno`, { texto: 'quero falar com um atendente' });
    } finally { sem.restaurar(); }
    return { r, c: db.prepare('SELECT * FROM conversas WHERE ligacao_uid = ?').get(uid) };
  };

  before(async () => {
    meta = h.fingirMeta();
    ({ db, empresa, atendente } = h.criarAmbiente());
    chave = empresasLib.criarChaveApi(db, empresa.id, 'Asterisk').chave;
    db.prepare("UPDATE usuarios SET ramal = '201' WHERE id = ?").run(atendente.id);
    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(async () => { meta.restaurar(); await new Promise((r) => servidor.close(r)); });

  test('a transferência já leva a frase para sussurrar no ouvido do atendente', async () => {
    const { r } = await ligacaoTransferida('1800000001.1', '11977771111');
    assert.equal(r.dados.acao, 'transferir');
    assert.match(r.dados.sussurro, /^Ligação da ZOE/);
    assert.match(r.dados.sussurro, /identidade não confirmada/, 'o atendente sabe que ainda precisa confirmar o titular');
    assert.ok(r.dados.sussurro.length < 260, 'curta: uns poucos segundos de fala');
  });

  test('a passagem diz o que o cliente falou, o motivo e o que pede atenção', () => {
    const c = db.prepare("SELECT * FROM conversas WHERE ligacao_uid = '1800000001.1'").get();
    const p = passagem.montar(db, c.id);
    assert.equal(p.canal, 'telefone');
    assert.match(p.pediu, /internet está caindo/, 'a primeira coisa que o cliente disse, não o "quero atendente"');
    assert.ok(p.motivo);
    assert.ok(p.atencao.some((a) => /CPF ou CNPJ/.test(a)), 'cliente não identificado: o atendente é avisado');
    assert.deepEqual(p.dialogo.map((d) => d.quem).slice(0, 2), ['zoe', 'cliente']);
  });

  test('o ramal atende: a conversa passa para a dona do ramal e ela recebe o aviso no painel', async () => {
    const token = await entrar('marina@fibramais.com.br');
    const vazio = await painel('GET', `/empresas/${empresa.id}/ligacoes/para-mim`, token);
    assert.equal(vazio.dados.passagem, null);

    const r = await integracao('/voz/ligacoes/1800000001.1/atendida', { ramal: 'PJSIP/201-0000002a' });
    assert.equal(r.status, 200);
    assert.equal(r.dados.atendente, 'Marina Souza');
    const c = db.prepare("SELECT * FROM conversas WHERE ligacao_uid = '1800000001.1'").get();
    assert.equal(c.estado, 'humano');
    assert.equal(c.atendente_id, atendente.id);
    assert.equal(c.ligacao_ramal, '201');

    const aviso = await painel('GET', `/empresas/${empresa.id}/ligacoes/para-mim`, token);
    assert.equal(aviso.dados.passagem.conversa_id, c.id);
    assert.equal(aviso.dados.passagem.ramal, '201');
    assert.match(aviso.dados.passagem.pediu, /internet/);

    await painel('POST', `/empresas/${empresa.id}/conversas/${c.id}/passagem-vista`, token, {});
    const depois = await painel('GET', `/empresas/${empresa.id}/ligacoes/para-mim`, token);
    assert.equal(depois.dados.passagem, null, 'visto uma vez, não abre de novo');
  });

  test('a central repetir o aviso não duplica nada', async () => {
    await integracao('/voz/ligacoes/1800000001.1/atendida', { ramal: '201' });
    const c = db.prepare("SELECT id, passagem_vista_em FROM conversas WHERE ligacao_uid = '1800000001.1'").get();
    assert.ok(c.passagem_vista_em, 'o aviso já visto continua visto');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM mensagens WHERE conversa_id = ? AND texto LIKE '%atendeu a ligação no ramal%'").get(c.id).n, 1);
  });

  test('a conversa aberta no painel traz a passagem', async () => {
    const token = await entrar('marina@fibramais.com.br');
    const c = db.prepare("SELECT id FROM conversas WHERE ligacao_uid = '1800000001.1'").get();
    const d = await painel('GET', `/empresas/${empresa.id}/conversas/${c.id}`, token);
    assert.equal(d.dados.passagem.conversa_id, c.id);
    assert.ok(Array.isArray(d.dados.passagem.ja_fez));
  });

  test('desligar depois de atendida conta como resolvida por pessoa', async () => {
    const r = await integracao('/voz/ligacoes/1800000001.1/fim');
    assert.equal(r.dados.resolvida_por, 'humano');
  });

  test('ramal sem usuário fica registrado, e a conversa continua na fila para quem abrir', async () => {
    const { c } = await ligacaoTransferida('1800000002.1', '11977772222');
    const r = await integracao('/voz/ligacoes/1800000002.1/atendida', { ramal: '299' });
    assert.equal(r.dados.atendente, null);
    const depois = db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id);
    assert.equal(depois.estado, 'aguardando');
    assert.equal(depois.ligacao_ramal, '299');
    assert.ok(db.prepare("SELECT 1 FROM mensagens WHERE conversa_id = ? AND texto LIKE '%ramal 299, que não está ligado%'").get(c.id));
    // Atendida, ainda que por um ramal sem usuário: desligar não é abandono.
    assert.equal((await integracao('/voz/ligacoes/1800000002.1/fim')).dados.resolvida_por, 'humano');
  });

  test('desligar na fila, antes de alguém atender, é abandono', async () => {
    await ligacaoTransferida('1800000003.1', '11977773333');
    const r = await integracao('/voz/ligacoes/1800000003.1/fim');
    assert.equal(r.dados.resolvida_por, 'abandono');
    const c = db.prepare("SELECT id FROM conversas WHERE ligacao_uid = '1800000003.1'").get();
    assert.ok(db.prepare("SELECT 1 FROM mensagens WHERE conversa_id = ? AND texto LIKE '%desligou na fila%'").get(c.id));
  });

  test('ligação esquecida aberta (sem o "h" no plano de discagem) fecha sozinha depois de 4 horas', async () => {
    const { c } = await ligacaoTransferida('1800000004.1', '11977774444');
    db.prepare('UPDATE conversas SET aberta_em = ? WHERE id = ?').run(new Date(Date.now() - 5 * 3_600_000).toISOString(), c.id);
    assert.deepEqual(encerrarLigacoesEsquecidas(db), [c.id]);
    assert.equal(db.prepare('SELECT estado FROM conversas WHERE id = ?').get(c.id).estado, 'encerrada');
  });

  test('o cliente ligar de novo com a ligação anterior ainda aberta não é recusado', async () => {
    const { c } = await ligacaoTransferida('1800000005.1', '11977775555');
    const r = await integracao('/voz/ligacoes', { uid: '1800000005.2', telefone: '11977775555' });
    assert.equal(r.status, 201, 'a ZOE atende a ligação nova');
    const velha = db.prepare('SELECT estado, resolvida_por FROM conversas WHERE id = ?').get(c.id);
    assert.equal(velha.estado, 'encerrada');
    assert.equal(velha.resolvida_por, 'abandono', 'estava na fila, ninguém atendeu');
    assert.ok(db.prepare("SELECT 1 FROM mensagens WHERE conversa_id = ? AND texto LIKE '%ligou de novo%'").get(c.id));
  });

  test('o ramal é cadastrado em Usuários, só números e sem repetir', async () => {
    const token = await entrar('carlos@fibramais.com.br');
    const admin = db.prepare("SELECT id FROM usuarios WHERE email = 'carlos@fibramais.com.br'").get();
    const repetido = await painel('PATCH', `/empresas/${empresa.id}/usuarios/${admin.id}`, token, { ramal: '201' });
    assert.equal(repetido.status, 422);
    assert.match(repetido.dados.erro, /já é de Marina/);
    const letras = await painel('PATCH', `/empresas/${empresa.id}/usuarios/${admin.id}`, token, { ramal: 'abc' });
    assert.equal(letras.status, 422);
    const ok = await painel('PATCH', `/empresas/${empresa.id}/usuarios/${admin.id}`, token, { ramal: '202' });
    assert.equal(ok.dados.ramal, '202');
    const tirar = await painel('PATCH', `/empresas/${empresa.id}/usuarios/${admin.id}`, token, { ramal: '' });
    assert.equal(tirar.dados.ramal, null);
    const mesmo = await painel('PATCH', `/empresas/${empresa.id}/usuarios/${atendente.id}`, token, { ramal: '201' });
    assert.equal(mesmo.status, 200, 'salvar o próprio ramal de novo não é conflito');
  });

  test('aviso de ligação de outra empresa não passa', async () => {
    const outra = empresasLib.criar(db, { nome: 'Outra Net', email: 'a@outra.net' });
    const chaveOutra = empresasLib.criarChaveApi(db, outra.id, 'Asterisk').chave;
    const r = await fetch(`${base}/api/integracao/voz/ligacoes/1800000002.1/atendida`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': chaveOutra }, body: JSON.stringify({ ramal: '201' }),
    });
    assert.equal(r.status, 404);
  });
});

describe('o que a ZOE já fez, em frases de gente', () => {
  test('ações do IXC viram frases, sem repetir, e as falhas vão para atenção', () => {
    const r = passagem.oQueFez([
      { tipo: 'identificacao', sucesso: 1, detalhe: null },
      { tipo: 'confirmacao', sucesso: 0, detalhe: 'tentativa 1 por cpf3' },
      { tipo: 'confirmacao', sucesso: 1, detalhe: 'confirmada por cpf3' },
      { tipo: 'conexao', sucesso: 1, detalhe: '1 login(s), 0 online' },
      { tipo: 'conexao', sucesso: 1, detalhe: '1 login(s), 0 online' },
      { tipo: 'boleto', sucesso: 1, detalhe: '{"fatura":12,"pix":true}' },
      { tipo: 'chamado', sucesso: 1, detalhe: '{"protocolo":"2026-0042"}' },
    ]);
    assert.deepEqual(r.feitas, [
      'Encontrou o cadastro do cliente no IXC',
      'Confirmou a identidade do titular',
      'Testou a conexão: 1 login(s), 0 online',
      'Enviou a segunda via da fatura',
      'Abriu chamado técnico no IXC (protocolo 2026-0042)',
    ]);
    assert.deepEqual(r.falhas, ['O cliente errou a confirmação de identidade']);
  });

  test('o sussurro cabe em poucos segundos e não lê protocolo', () => {
    const s = passagem.sussurro({
      nome: 'Ana Maria de Souza Lima', identidade: true, motivo: 'Internet caindo à noite.',
      feitas: ['Testou a conexão: 1 login(s), 0 online', 'Abriu chamado técnico no IXC (protocolo 2026-0042)'],
    });
    assert.equal(s, 'Ligação da ZOE: Ana Maria, identidade confirmada. Assunto: Internet caindo à noite. Já feito: Testou a conexão e abriu chamado técnico no IXC.');
    const comFala = passagem.sussurro({ nome: null, identidade: false, motivo: 'O cliente pediu atendimento humano ("atendente").', pediu: 'minha internet cai toda noite' });
    assert.equal(comFala, 'Ligação da ZOE, identidade não confirmada. Assunto: minha internet cai toda noite.', 'o assunto é o que o cliente disse, não o motivo técnico');
  });

  test('ramal vem do canal do Asterisk', () => {
    assert.equal(voz.normalizarRamal('PJSIP/201-0000002a'), '201');
    assert.equal(voz.normalizarRamal('Local/3005@from-queue-1;1'), '3005');
    assert.equal(voz.normalizarRamal('202'), '202');
    assert.equal(voz.normalizarRamal('PJSIP/operadora'), null);
  });
});
