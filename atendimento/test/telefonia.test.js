'use strict';

/**
 * A telefonia (o PABX) dentro da ZOE: um login, um cadastro de empresas e usuários, as mesmas filas
 * do WhatsApp, as mesmas permissões. Aqui o caminho inteiro: o master liga a telefonia da empresa,
 * a empresa monta ramais, filas no telefone, URA e números, a central informa as chamadas e a
 * tarifação fecha.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const empresasLib = require('../server/lib/empresas');
const { classificar, tarifar, simultaneas } = require('../server/telefonia/chamadas');

test('funções de apoio da tarifação', () => {
  assert.equal(classificar('1001'), 'interno');
  assert.equal(classificar('11987654321'), 'movel');
  assert.equal(classificar('1133224455'), 'fixo');
  assert.equal(classificar('0014155550100'), 'internacional');
  assert.equal(tarifar(5, 30, 6), 30);
  assert.equal(tarifar(95, 30, 6), 96);
  const ini = Date.parse('2026-10-21T00:00:00Z');
  const t = (min) => new Date(ini + min * 60_000).toISOString();
  assert.deepEqual(simultaneas([{ inicio: t(5), fim: t(20) }, { inicio: t(16), fim: t(40) }, { inicio: t(50), fim: t(51) }], ini, ini + 3_600_000, 900_000), [1, 2, 1, 1]);
});

describe('telefonia dentro da ZOE', () => {
  let meta;
  let db;
  let empresa;
  let filas;
  let servidor;
  let base;
  let master;
  let admin;
  let atendente;
  let chave;
  let tronco;
  let ramal1001;
  let fila;

  const req = async (metodo, caminho, corpo, tk, extra = {}) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}), ...extra },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await r.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* csv ou vazio */ }
    return { status: r.status, dados, headers: r.headers };
  };
  const entrar = async (email, senha = 'senha12345') => (await req('POST', '/auth/login', { email, senha })).dados.token;
  const tel = (c) => `/empresas/${empresa.id}/telefonia${c}`;
  const central = (k) => ({
    get: (c) => req('GET', `/central${c}`, undefined, null, { 'X-Api-Key': k }),
    post: (c, b) => req('POST', `/central${c}`, b ?? {}, null, { 'X-Api-Key': k }),
  });

  test('preparar', async () => {
    meta = h.fingirMeta();
    ({ db, empresa, filas } = h.criarAmbiente());
    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}/api`;
    master = await entrar('master@atendimento.com.br', 'master123');
    admin = await entrar('carlos@fibramais.com.br');
    atendente = await entrar('marina@fibramais.com.br');
    fila = filas[0].id;
  });

  test('sem a telefonia ligada pelo master, a empresa não usa', async () => {
    const r = await req('GET', tel('/ramais'), undefined, admin);
    assert.equal(r.status, 403);
    assert.match(r.dados.erro, /não está ligada/);
  });

  test('o master cria a rota de saída e liga a telefonia da empresa, com limites e tarifas', async () => {
    assert.equal((await req('POST', '/master/telefonia/troncos', { nome: 'Operadora', host: 'sip.op.exemplo', usuario: 'conta', senha: 'segredo-do-tronco', custo_movel_centavos: 10 }, master)).status, 201);
    tronco = (await req('GET', '/master/telefonia/troncos', undefined, master)).dados[0].id;
    const r = await req('PUT', `/master/telefonia/empresas/${empresa.id}`, {
      telefonia_ativa: true, tipo: 'discador', limite_ramais: 2, limite_canais: 2, disco_mb: 1, tts_limite: 10,
      tarifa_movel_centavos: 30, tronco_id: tronco,
    }, master);
    assert.equal(r.status, 204);
    const lista = (await req('GET', '/master/telefonia/empresas?tipo=discador', undefined, master)).dados;
    assert.equal(lista[0].id, empresa.id);
    assert.equal(lista[0].telefonia_ativa, 1);
    // Quem é da empresa não mexe na telefonia da plataforma.
    assert.equal((await req('GET', '/master/telefonia/troncos', undefined, admin)).status, 403);
  });

  test('ramais respeitam o limite e o número único, sem expor a senha SIP na lista', async () => {
    const r1 = await req('POST', tel('/ramais'), { numero: '1001', nome: 'Marina' }, admin);
    assert.equal(r1.status, 201);
    ramal1001 = r1.dados.id;
    assert.equal((await req('POST', tel('/ramais'), { numero: '1001', nome: 'Outra' }, admin)).status, 409);
    assert.equal((await req('POST', tel('/ramais'), { numero: '1', nome: 'Outra' }, admin)).status, 422);
    assert.equal((await req('POST', tel('/ramais'), { numero: '1002', nome: 'Rafael' }, admin)).status, 201);
    const cheio = await req('POST', tel('/ramais'), { numero: '1003', nome: 'Juliana' }, admin);
    assert.equal(cheio.status, 422);
    assert.match(cheio.dados.erro, /Limite de 2 ramais/);
    const lista = (await req('GET', tel('/ramais'), undefined, admin)).dados;
    assert.ok(!('senha_sip' in lista[0]));
    const sip = (await req('GET', tel(`/ramais/${ramal1001}/sip`), undefined, admin)).dados;
    assert.equal(sip.usuario, `${empresa.id}_1001`);
  });

  test('as permissões da ZOE valem na telefonia: o atendente não configura', async () => {
    assert.equal((await req('GET', tel('/ramais'), undefined, atendente)).status, 403, 'atendente não tem "ver telefonia" de fábrica');
    assert.equal((await req('POST', tel('/ramais'), { numero: '1009', nome: 'X' }, atendente)).status, 403);
    // O telefone do painel ele usa (permissão própria).
    assert.equal((await req('GET', tel('/telefone'), undefined, atendente)).status, 200);
  });

  test('a fila do telefone é a mesma do WhatsApp: ganha ramais e estratégia, o nome não muda aqui', async () => {
    const r = await req('PUT', tel(`/filas/${fila}`), { ramais: [ramal1001], estrategia: 'sequencial', nome: 'Outro nome' }, admin);
    assert.equal(r.status, 204);
    const f = (await req('GET', tel('/filas'), undefined, admin)).dados.find((x) => x.id === fila);
    assert.equal(f.nome, filas[0].nome);
    assert.equal(f.estrategia, 'sequencial');
    assert.deepEqual(f.ramais.map((x) => x.numero), ['1001']);
  });

  test('URA e número entrante', async () => {
    const ura = await req('POST', tel('/uras'), { nome: 'Menu', mensagem: 'Olá', opcoes: [{ digito: '1', destino_tipo: 'fila', destino_id: fila }] }, admin);
    assert.equal(ura.status, 201);
    const noZero = await req('POST', tel('/uras'), { nome: 'X', mensagem: 'Olá', opcoes: [{ digito: '0', destino_tipo: 'fila', destino_id: fila }] }, admin);
    assert.equal(noZero.status, 422, 'a tecla do atendente não vira opção');
    assert.equal((await req('POST', '/master/telefonia/numeros', { numeros: '1130001000\n1130001001', tronco_id: tronco, empresa_id: empresa.id }, master)).dados.criados, 2);
    const numeros = (await req('GET', tel('/numeros'), undefined, admin)).dados;
    assert.equal((await req('PATCH', tel(`/numeros/${numeros[0].id}`), { destino_tipo: 'ura', destino_id: ura.dados.id }, admin)).status, 204);
    assert.equal((await req('GET', tel('/numeros'), undefined, admin)).dados[0].destino_nome, 'Menu');
    // O segundo número cai direto na ZOE; e a URA pode mandar para ela também.
    assert.equal((await req('PATCH', tel(`/numeros/${numeros[1].id}`), { destino_tipo: 'zoe', destino_id: 999 }, admin)).status, 204);
    const n2 = (await req('GET', tel('/numeros'), undefined, admin)).dados[1];
    assert.deepEqual([n2.destino_tipo, n2.destino_id, n2.destino_nome], ['zoe', null, 'ZOE']);
    const comZoe = await req('PUT', tel(`/uras/${ura.dados.id}`), { opcoes: [{ digito: '1', destino_tipo: 'fila', destino_id: fila }, { digito: '2', destino_tipo: 'zoe' }] }, admin);
    assert.ok(comZoe.status < 300, JSON.stringify(comZoe.dados));
  });

  test('chave da central: só o master cria, e a de integração comum não informa chamadas', async () => {
    assert.equal((await req('POST', '/master/telefonia/chaves', { empresa_id: empresa.id }, admin)).status, 403);
    const k = await req('POST', '/master/telefonia/chaves', { empresa_id: empresa.id, nome: 'Asterisk' }, master);
    assert.equal(k.status, 201);
    chave = k.dados.chave;
    assert.match(chave, /^cen_/);
    const comum = empresasLib.criarChaveApi(db, empresa.id, 'ERP').chave;
    assert.equal((await central(comum).get('/config')).status, 401, 'chave de integração não é chave da central');
    const cfg = (await central(chave).get('/config')).dados;
    assert.deepEqual(cfg.ramais.map((r) => r.numero), ['1001', '1002']);
    assert.equal(cfg.terminacao.host, 'sip.op.exemplo');
    assert.ok(!('senha' in cfg.terminacao) && !('usuario' in cfg.terminacao), 'a credencial do tronco não sai pela API');
    assert.deepEqual(cfg.numeros.map((n) => n.destino_tipo), ['ura', 'zoe']);
    assert.deepEqual(cfg.uras[0].opcoes.at(-1), { digito: '2', destino_tipo: 'zoe', destino_id: null });
    assert.equal(cfg.uras[0].tipo, 'classica');
    assert.equal(cfg.uras[0].tecla_atendente, '0');
    assert.equal(cfg.ramais[0].usuario_sip_web, `${empresa.id}_1001w`);
    assert.deepEqual(cfg.filas.find((f) => f.id === fila).ramais, ['1001']);
    // A mesma chave fala com o cérebro da ZOE (a ligação conversada).
    const voz = await req('POST', '/integracao/voz/ligacoes', { uid: 'c-1', telefone: '11977776666' }, null, { 'X-Api-Key': chave });
    assert.equal(voz.status, 201);
  });

  test('chamadas: tarifação, limite de canais e painel', async () => {
    const c = central(chave);
    const inicio = new Date(Date.now() - 120_000).toISOString();
    assert.equal((await c.post('/chamadas', { uid: 'a1', direcao: 'saida', origem: '1001', destino: '11987654321', inicio })).status, 201);
    assert.equal((await c.post('/chamadas', { uid: 'b1', direcao: 'entrada', origem: '1133224455', destino: '1002', numero: '1130001000' })).status, 201);
    assert.equal((await c.post('/chamadas', { uid: 'c1', direcao: 'saida', origem: '1002', destino: '1133224455' })).status, 429, 'limite de 2 canais');
    const atendida = new Date(Date.parse(inicio) + 10_000).toISOString();
    await c.post('/chamadas/a1/atendida', { em: atendida });
    const fim = await c.post('/chamadas/a1/fim', { fim: new Date(Date.parse(atendida) + 95_000).toISOString() });
    assert.equal(fim.dados.custo_centavos, 48, '95 s → 96 s tarifados (30/6) × R$ 0,30/min');
    await c.post('/chamadas/b1/fim', { status: 'nao_atendida' });
    const lista = (await req('GET', tel('/chamadas'), undefined, admin)).dados;
    assert.equal(lista.total, 2);
    assert.equal(lista.custo_centavos, 48);
    const d = (await req('GET', tel('/dashboard'), undefined, admin)).dados;
    assert.equal(d.utilizacao.mes.gastos_centavos, 48);
    assert.equal((await req('GET', `/master/telefonia/chamadas?empresa_id=${empresa.id}`, undefined, master)).dados.total, 2);
  });

  test('campanha: importação, ativação e discador', async () => {
    const cp = (await req('POST', tel('/campanhas'), { nome: 'Novembro', canais: 1, fila_id: fila }, admin)).dados.id;
    const imp = await req('POST', tel(`/campanhas/${cp}/contatos`), { linhas: 'Maria;11911112222\n11933334444' }, admin);
    assert.equal(imp.dados.importados, 2);
    assert.equal((await req('PATCH', tel(`/campanhas/${cp}`), { status: 'ativa' }, admin)).status, 204);
    const prox = (await central(chave).post(`/campanhas/${cp}/proximos`)).dados;
    assert.equal(prox.contatos.length, 1);
    assert.equal(prox.fila.id, fila);
  });

  test('o telefone do painel usa o ramal de Usuários › Ramal, e só o próprio', async () => {
    const semRamal = (await req('GET', tel('/telefone'), undefined, atendente)).dados;
    assert.equal(semRamal.ramal, null);
    db.prepare("UPDATE usuarios SET ramal = '1001' WHERE email = 'marina@fibramais.com.br'").run();
    const comRamal = (await req('GET', tel('/telefone'), undefined, atendente)).dados;
    assert.equal(comRamal.ramal.numero, '1001');
    assert.equal(comRamal.ramal.usuario_sip, `${empresa.id}_1001w`, 'o navegador usa o cadastro WebRTC do ramal');
    assert.ok(comRamal.ramal.senha_sip.length >= 12);
  });

  test('fim', async () => { meta.restaurar(); await new Promise((r) => servidor.close(r)); });
});
