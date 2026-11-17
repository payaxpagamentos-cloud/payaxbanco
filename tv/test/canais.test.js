'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { dataXmltv } = require('../server/lib/epg');

const agoraMais = (minutos) => new Date(Date.now() + minutos * 60_000).toISOString();

test('canal: cadastro, endereço do sinal e situação', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const ruim = await s.post('/admin/canais', { numero: 4, nome: 'Canal', url_hls: 'ftp://origem/x.m3u8' }, admin);
  assert.equal(ruim.status, 422);
  const comSenha = await s.post('/admin/canais', { numero: 4, nome: 'Canal', url_hls: 'https://user:senha@origem.test/x.m3u8' }, admin);
  assert.equal(comSenha.status, 422, 'endereço com usuário e senha é recusado');

  const c = await s.post('/admin/canais', { numero: 4, nome: 'PayAx 4 Aberta', categoria: 'aberta', url_hls: 'https://origem.test/live.m3u8' }, admin);
  assert.equal(c.status, 201);
  assert.equal(c.dados.canal.slug, 'payax-4-aberta');
  assert.equal(c.dados.canal.relay, 1, 'por padrão o sinal passa pelo nosso servidor');

  const repetido = await s.post('/admin/canais', { numero: 4, nome: 'Outro', url_hls: 'https://origem.test/outro.m3u8' }, admin);
  assert.equal(repetido.status, 409, 'número de canal não se repete');
});

test('grade: programa no ar agora, sem sobreposição, e guia do assinante', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 5, nome: 'PayAx News', categoria: 'noticias', url_hls: 'https://origem.test/news.m3u8' }, admin)).dados.canal;

  const agora = await s.post(`/admin/canais/${canal.id}/programas`, { titulo: 'Jornal das Seis', inicio: agoraMais(-20), fim: agoraMais(40), ao_vivo: true }, admin);
  assert.equal(agora.status, 201);
  const depois = await s.post(`/admin/canais/${canal.id}/programas`, { titulo: 'Mesa Redonda', inicio: agoraMais(40), fim: agoraMais(100) }, admin);
  assert.equal(depois.status, 201);

  const choque = await s.post(`/admin/canais/${canal.id}/programas`, { titulo: 'Choque', inicio: agoraMais(30), fim: agoraMais(50) }, admin);
  assert.equal(choque.status, 409);
  assert.match(choque.dados.erro, /Jornal das Seis/);

  const invertido = await s.post(`/admin/canais/${canal.id}/programas`, { titulo: 'Invertido', inicio: agoraMais(200), fim: agoraMais(120) }, admin);
  assert.equal(invertido.status, 422);

  const cliente = await s.assinante('guia@exemplo.com.br', { plano: 2 });
  const canais = await s.get('/tv/canais', cliente.token, cliente.comPerfil);
  const noAr = canais.dados.canais[0];
  assert.equal(noAr.agora.titulo, 'Jornal das Seis');
  assert.ok(noAr.agora.andamento > 0 && noAr.agora.andamento < 100);
  assert.equal(noAr.depois.titulo, 'Mesa Redonda');

  const guia = await s.get('/tv/guia', cliente.token, cliente.comPerfil);
  assert.equal(guia.dados.canais[0].programas.length >= 2, true);
  const futuro = guia.dados.canais[0].programas.find((p) => p.titulo === 'Mesa Redonda');
  assert.equal(futuro.andamento, null, 'programa que ainda não começou não tem andamento');
});

test('importação XMLTV preenche a grade do canal', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 7, nome: 'Arena PayAx', categoria: 'esportes', url_hls: 'https://origem.test/arena.m3u8' }, admin)).dados.canal;

  const xml = `<?xml version="1.0"?><tv>
    <programme start="20260320180000 -0300" stop="20260320200000 -0300" channel="7">
      <title>Brasileirão ao vivo</title><desc>Clássico da rodada</desc><category>Esportes</category><rating><value>10</value></rating>
    </programme>
    <programme start="20260320200000 -0300" stop="20260320210000 -0300" channel="7">
      <title>Resenha Esportiva</title>
    </programme>
    <programme start="20260320210000 -0300" stop="20260320220000 -0300" channel="999">
      <title>De um canal que não existe aqui</title>
    </programme>
  </tv>`;

  const r = await s.post('/admin/epg/xmltv', xml, admin, { headers: { 'Content-Type': 'application/xml' } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  assert.equal(r.dados.importados, 2);
  assert.equal(r.dados.ignorados, 1);
  assert.equal(r.dados.canais, 1);

  const grade = await s.get(`/admin/canais/${canal.id}/programas?de=2026-03-20T00:00:00Z&ate=2026-03-21T00:00:00Z`, admin);
  const titulos = grade.dados.programas.map((p) => p.titulo);
  assert.deepEqual(titulos, ['Brasileirão ao vivo', 'Resenha Esportiva']);
  assert.equal(grade.dados.programas[0].classificacao, 10);
  assert.equal(grade.dados.programas[0].inicio, '2026-03-20T21:00:00.000Z');

  // Importar de novo substitui o período, sem duplicar.
  const denovo = await s.post('/admin/epg/xmltv', xml, admin, { headers: { 'Content-Type': 'application/xml' } });
  assert.equal(denovo.dados.importados, 2);
  const grade2 = await s.get(`/admin/canais/${canal.id}/programas?de=2026-03-20T00:00:00Z&ate=2026-03-21T00:00:00Z`, admin);
  assert.equal(grade2.dados.programas.length, 2);
});

test('data do XMLTV com e sem fuso', () => {
  assert.equal(dataXmltv('20260320180000 -0300'), '2026-03-20T21:00:00.000Z');
  assert.equal(dataXmltv('20260320180000'), '2026-03-20T18:00:00.000Z');
  assert.equal(dataXmltv('não é data'), null);
});

test('canal só do plano superior fica bloqueado para o plano básico', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 11, nome: 'Cine PayAx', categoria: 'filmes', url_hls: 'https://origem.test/cine.m3u8', plano_minimo_id: 3 }, admin)).dados.canal;

  const basico = await s.assinante('canalbasico@exemplo.com.br', { plano: 1 });
  const lista = await s.get('/tv/canais', basico.token, basico.comPerfil);
  assert.equal(lista.dados.canais[0].bloqueado, true);
  const play = await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id }, basico.token, basico.comPerfil);
  assert.equal(play.status, 403);
  assert.equal(play.dados.detalhes.motivo, 'plano');
});

test('canal fora do ar não aparece para o assinante', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 20, nome: 'Documento Brasil', url_hls: 'https://origem.test/doc.m3u8' }, admin)).dados.canal;
  await s.patch(`/admin/canais/${canal.id}`, { ativo: false }, admin);
  const cliente = await s.assinante('semcanal@exemplo.com.br', { plano: 2 });
  assert.equal((await s.get('/tv/canais', cliente.token, cliente.comPerfil)).dados.canais.length, 0);
  assert.equal((await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id }, cliente.token, cliente.comPerfil)).status, 404);
});
