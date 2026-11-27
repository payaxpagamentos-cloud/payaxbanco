'use strict';

/**
 * As memórias curtas (lib/memoria.js) trocam consulta repetida por resultado guardado. O risco
 * de toda memória é entregar a alguém o que era de outro, ou o que já mudou. Estes testes
 * conferem exatamente isso — o ganho de tempo está medido à parte, não aqui.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

const iso = (ms) => new Date(ms).toISOString();

test('a lista de canais guardada não vaza de um banco para outro', async (t) => {
  const a = await iniciar();
  const b = await iniciar();
  t.after(() => Promise.all([a.fechar(), b.fechar()]));

  for (const [s, nome] of [[a, 'Canal do Banco A'], [b, 'Canal do Banco B']]) {
    const admin = await s.adminLogin();
    const r = await s.post('/admin/canais', { numero: 90, nome, url_hls: 'https://origem.test/x.m3u8' }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
  }
  const ca = await a.assinante('a@exemplo.com.br', { plano: 2 });
  const cb = await b.assinante('b@exemplo.com.br', { plano: 2 });
  // Pedidos em seguida, dentro da validade da memória: cada um tem de ver só o seu banco.
  const nomesA = (await a.get('/tv/canais', ca.token, ca.comPerfil)).dados.canais.map((c) => c.nome);
  const nomesB = (await b.get('/tv/canais', cb.token, cb.comPerfil)).dados.canais.map((c) => c.nome);
  assert.ok(nomesA.includes('Canal do Banco A') && !nomesA.includes('Canal do Banco B'));
  assert.ok(nomesB.includes('Canal do Banco B') && !nomesB.includes('Canal do Banco A'));
});

test('programa salvo no painel aparece na hora, apesar da memória', async (t) => {
  const s = await iniciar();
  t.after(() => s.fechar());
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 91, nome: 'PLAY Memória', url_hls: 'https://origem.test/m.m3u8' }, admin)).dados.canal;
  const c = await s.assinante('grade@exemplo.com.br', { plano: 2 });
  const doCanal = async () => (await s.get('/tv/canais', c.token, c.comPerfil)).dados.canais.find((x) => x.id === canal.id);
  const noGuia = async () => (await s.get('/tv/guia', c.token, c.comPerfil)).dados.canais.find((x) => x.id === canal.id).programas.map((p) => p.titulo);

  // Primeiro pedido: enche as duas memórias com o canal ainda sem grade.
  assert.equal((await doCanal()).agora, null);
  assert.deepEqual(await noGuia(), []);

  const novo = await s.post(`/admin/canais/${canal.id}/programas`, {
    titulo: 'Jornal da Memória', inicio: iso(Date.now() - 10 * 60_000), fim: iso(Date.now() + 50 * 60_000),
  }, admin);
  assert.equal(novo.status, 201, JSON.stringify(novo.dados));

  // Sem o aviso de que a grade mudou, isto só apareceria 20–30 s depois — e a operação
  // salvaria o programa, olharia o app e concluiria que não funcionou.
  assert.equal((await doCanal()).agora?.titulo, 'Jornal da Memória');
  assert.deepEqual(await noGuia(), ['Jornal da Memória']);

  // Apagar também vale na hora.
  assert.equal((await s.del(`/admin/programas/${novo.dados.programa.id}`, undefined, admin)).status, 204);
  assert.equal((await doCanal()).agora, null);
});

test('"populares" segue a audiência de verdade, e o empate fica com o mais recente', async (t) => {
  const s = await iniciar();
  t.after(() => s.fechar());
  const c = await s.assinante('populares@exemplo.com.br', { plano: 2 });
  const agora = iso(Date.now());
  const ins = s.db.prepare("INSERT INTO titulos (tipo,nome,slug,situacao,publicado_em,criado_em,atualizado_em) VALUES ('filme',?,?,'publicado',?,?,?)");
  const id = {};
  // Publicados em ordem: Antigo, Meio, Novo.
  for (const [nome, haDias] of [['Antigo', 30], ['Meio', 20], ['Novo', 10], ['Sem Audiência', 5]]) {
    id[nome] = Number(ins.run(nome, nome.toLowerCase().replace(/\W+/g, '-'), iso(Date.now() - haDias * 86_400_000), agora, agora).lastInsertRowid);
  }
  const sessao = s.db.prepare("INSERT INTO sessoes_player (usuario_id,perfil_id,tipo,titulo_id,iniciada_em,ultimo_ping,encerrada_em) VALUES (?,?,'filme',?,?,?,?)");
  const abrir = (titulo, vezes, haDias = 1) => {
    const q = iso(Date.now() - haDias * 86_400_000);
    for (let i = 0; i < vezes; i += 1) sessao.run(c.usuario.id, c.perfilId, id[titulo], q, q, q);
  };
  abrir('Antigo', 5);
  abrir('Meio', 2);
  abrir('Novo', 2);            // empata com "Meio": ganha o publicado mais recentemente
  abrir('Sem Audiência', 9, 90); // muita audiência, mas fora da janela de 30 dias: não conta

  const r = await s.get('/tv/catalogo?ordem=populares', c.token, c.comPerfil);
  assert.equal(r.status, 200);
  assert.equal(r.dados.total, 4);
  assert.deepEqual(r.dados.itens.map((x) => x.nome), ['Antigo', 'Novo', 'Meio', 'Sem Audiência']);

  // A paginação continua batendo com a ordem.
  const p2 = await s.get('/tv/catalogo?ordem=populares&por_pagina=2&pagina=2', c.token, c.comPerfil);
  assert.deepEqual(p2.dados.itens.map((x) => x.nome), ['Meio', 'Sem Audiência']);
});

test('o painel conta as telas abertas de verdade, não o tamanho de uma lista limitada', async (t) => {
  const s = await iniciar();
  t.after(() => s.fechar());
  const admin = await s.adminLogin();
  const c = await s.assinante('telas@exemplo.com.br');
  const agora = iso(Date.now());
  const ins = s.db.prepare("INSERT INTO sessoes_player (usuario_id,perfil_id,tipo,iniciada_em,ultimo_ping) VALUES (?,?,'canal',?,?)");
  // 230 telas abertas: a lista do painel traz no máximo 200, e o indicador parava nesse teto.
  for (let i = 0; i < 230; i += 1) ins.run(c.usuario.id, c.perfilId, agora, agora);
  // E algumas que não contam: já encerradas, ou sem sinal de vida há muito tempo.
  s.db.prepare("INSERT INTO sessoes_player (usuario_id,perfil_id,tipo,iniciada_em,ultimo_ping,encerrada_em) VALUES (?,?,'canal',?,?,?)").run(c.usuario.id, c.perfilId, agora, agora, agora);
  ins.run(c.usuario.id, c.perfilId, iso(Date.now() - 3600_000), iso(Date.now() - 3600_000));

  const painel = await s.get('/admin/painel', admin);
  assert.equal(painel.dados.audiencia.telas_agora, 230);
});
