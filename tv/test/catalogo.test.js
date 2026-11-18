'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

/** Monta um filme publicado (capa + vídeo) e devolve os dados. */
async function filme(s, admin, { nome = 'Filme de Teste', classificacao = 0, plano_minimo_id: plano = null, original = false } = {}) {
  const capa = await s.enviarImagem(admin);
  const video = await s.enviarVideo(admin);
  const r = await s.post('/admin/titulos', { tipo: 'filme', nome, classificacao, capa_midia_id: capa, video_midia_id: video, plano_minimo_id: plano, original }, admin);
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  await s.post(`/admin/titulos/${r.dados.titulo.id}/situacao`, { situacao: 'publicado' }, admin);
  return r.dados.titulo;
}

test('a home traz destaques e fileiras só com o que está publicado', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const publicado = await filme(s, admin, { nome: 'No Ar', original: true });
  const rascunho = await s.post('/admin/titulos', { tipo: 'filme', nome: 'Ainda Não' }, admin);
  await s.post('/admin/destaques', { titulo_id: publicado.id, chamada: 'Estreia' }, admin);

  const cliente = await s.assinante('home@exemplo.com.br', { plano: 2 });
  const home = await s.get('/tv/home', cliente.token, cliente.comPerfil);
  assert.equal(home.status, 200);
  assert.equal(home.dados.destaques[0].titulo.nome, 'No Ar');
  const nomes = JSON.stringify(home.dados.fileiras);
  assert.ok(nomes.includes('No Ar'));
  assert.ok(!nomes.includes('Ainda Não'), 'rascunho não aparece para o assinante');
  assert.equal((await s.get(`/tv/titulos/${rascunho.dados.titulo.slug}`, cliente.token, cliente.comPerfil)).status, 404);
});

test('publicar exige vídeo e capa', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const t1 = await s.post('/admin/titulos', { tipo: 'filme', nome: 'Sem Nada' }, admin);
  const semVideo = await s.post(`/admin/titulos/${t1.dados.titulo.id}/situacao`, { situacao: 'publicado' }, admin);
  assert.equal(semVideo.status, 409);
  assert.match(semVideo.dados.erro, /vídeo/i);

  const video = await s.enviarVideo(admin);
  await s.patch(`/admin/titulos/${t1.dados.titulo.id}`, { video_midia_id: video }, admin);
  const semCapa = await s.post(`/admin/titulos/${t1.dados.titulo.id}/situacao`, { situacao: 'publicado' }, admin);
  assert.equal(semCapa.status, 409);
  assert.match(semCapa.dados.erro, /capa/i);
});

test('perfil infantil não vê (nem abre) conteúdo acima da classificação', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const adulto = await filme(s, admin, { nome: 'Noite Pesada', classificacao: 16 });
  const livre = await filme(s, admin, { nome: 'Turma do Quintal', classificacao: 0 });

  const cliente = await s.assinante('familia@exemplo.com.br', { plano: 2 });
  const infantil = await s.post('/conta/perfis', { nome: 'Kids', infantil: true }, cliente.token);
  const comKids = { headers: { 'X-Perfil': String(infantil.dados.perfil.id) } };
  assert.equal(infantil.dados.perfil.classificacao_max, 10);

  const home = await s.get('/tv/home', cliente.token, comKids);
  assert.ok(!JSON.stringify(home.dados.fileiras).includes('Noite Pesada'));
  assert.ok(JSON.stringify(home.dados.fileiras).includes('Turma do Quintal'));

  assert.equal((await s.get(`/tv/titulos/${adulto.slug}`, cliente.token, comKids)).status, 403);
  const play = await s.post('/play/abrir', { tipo: 'filme', titulo_id: adulto.id }, cliente.token, comKids);
  assert.equal(play.status, 403);
  assert.equal(play.dados.detalhes.motivo, 'classificacao');
  assert.equal((await s.post('/play/abrir', { tipo: 'filme', titulo_id: livre.id }, cliente.token, comKids)).status, 201);
});

test('título de plano superior aparece marcado e não abre no plano básico', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const exclusivo = await filme(s, admin, { nome: 'Exclusivo 4K', plano_minimo_id: 3 });

  const cliente = await s.assinante('basico@exemplo.com.br', { plano: 1 });
  const det = await s.get(`/tv/titulos/${exclusivo.slug}`, cliente.token, cliente.comPerfil);
  assert.equal(det.status, 200);
  assert.equal(det.dados.titulo.bloqueado, true);
  assert.equal(det.dados.titulo.plano_nome, 'Cinema 4K');

  const play = await s.post('/play/abrir', { tipo: 'filme', titulo_id: exclusivo.id }, cliente.token, cliente.comPerfil);
  assert.equal(play.status, 403);
  assert.equal(play.dados.detalhes.motivo, 'plano');

  // Quem assina o plano de nível maior assiste.
  const vip = await s.assinante('vip@exemplo.com.br', { plano: 3 });
  assert.equal((await s.post('/play/abrir', { tipo: 'filme', titulo_id: exclusivo.id }, vip.token, vip.comPerfil)).status, 201);
});

test('minha lista, continuar assistindo e busca', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const f = await filme(s, admin, { nome: 'Maré Alta' });
  const cliente = await s.assinante('lista@exemplo.com.br', { plano: 2 });

  await s.post(`/tv/minha-lista/${f.id}`, {}, cliente.token, cliente.comPerfil);
  const lista = await s.get('/tv/minha-lista', cliente.token, cliente.comPerfil);
  assert.equal(lista.dados.itens[0].nome, 'Maré Alta');

  await s.post('/tv/progresso', { titulo_id: f.id, segundos: 900, duracao_s: 3600 }, cliente.token, cliente.comPerfil);
  const continuar = await s.get('/tv/continuar', cliente.token, cliente.comPerfil);
  assert.equal(continuar.dados.itens[0].retomar.segundos, 900);
  assert.equal(continuar.dados.itens[0].retomar.percentual, 25);

  const busca = await s.get('/tv/busca?q=mar%C3%A9', cliente.token, cliente.comPerfil);
  assert.equal(busca.dados.titulos[0].nome, 'Maré Alta');
  assert.equal((await s.get('/tv/busca?q=x', cliente.token, cliente.comPerfil)).status, 422, 'busca curta demais');

  // Quem terminou de assistir sai do "continuar assistindo".
  await s.post('/tv/progresso', { titulo_id: f.id, segundos: 3595, duracao_s: 3600 }, cliente.token, cliente.comPerfil);
  assert.equal((await s.get('/tv/continuar', cliente.token, cliente.comPerfil)).dados.itens.length, 0);
});

test('série: episódios, próximo episódio e retomada', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const capa = await s.enviarImagem(admin);
  const serie = (await s.post('/admin/titulos', { tipo: 'serie', nome: 'Capital Norte', capa_midia_id: capa }, admin)).dados.titulo;
  const temporada = (await s.get(`/admin/titulos/${serie.id}`, admin)).dados.temporadas[0];
  const ep1 = await s.post(`/admin/temporadas/${temporada.id}/episodios`, { nome: 'O porto', video_midia_id: await s.enviarVideo(admin), duracao_s: 2700, situacao: 'publicado' }, admin);
  const ep2 = await s.post(`/admin/temporadas/${temporada.id}/episodios`, { nome: 'A procuradora', video_midia_id: await s.enviarVideo(admin), duracao_s: 2700, situacao: 'publicado' }, admin);
  await s.post(`/admin/titulos/${serie.id}/situacao`, { situacao: 'publicado' }, admin);

  const cliente = await s.assinante('serie@exemplo.com.br', { plano: 2 });
  const det = await s.get(`/tv/titulos/${serie.slug}`, cliente.token, cliente.comPerfil);
  assert.equal(det.dados.titulo.temporadas[0].episodios.length, 2);
  assert.equal(det.dados.titulo.proximo_episodio.id, ep1.dados.episodio.id);

  const play = await s.post('/play/abrir', { tipo: 'episodio', titulo_id: serie.id, episodio_id: ep1.dados.episodio.id }, cliente.token, cliente.comPerfil);
  assert.equal(play.status, 201);
  assert.equal(play.dados.proximo_episodio.id, ep2.dados.episodio.id);

  // Depois de ver o primeiro, o próximo passa a ser o segundo.
  await s.post('/tv/progresso', { titulo_id: serie.id, episodio_id: ep1.dados.episodio.id, segundos: 2699, duracao_s: 2700 }, cliente.token, cliente.comPerfil);
  const det2 = await s.get(`/tv/titulos/${serie.slug}`, cliente.token, cliente.comPerfil);
  assert.equal(det2.dados.titulo.proximo_episodio.id, ep2.dados.episodio.id);
});

test('base de filmes: sem token configurado, o painel não oferece a busca', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const tmdb = require('../server/lib/tmdb');

  // No ambiente de teste não há token: a busca responde "desligada" em vez de quebrar.
  assert.equal(tmdb.ligado(), Boolean(process.env.TV_TMDB_TOKEN));
  if (tmdb.ligado()) {
    t.diagnostic('token do TMDB presente: o caminho sem token não foi exercitado');
    return;
  }
  const r = await s.get('/admin/tmdb/buscar?q=duna', admin);
  assert.equal(r.status, 200);
  assert.equal(r.dados.ligado, false);
  assert.deepEqual(r.dados.resultados, []);

  // E a importação da ficha avisa o motivo, sem erro genérico.
  const capa = await s.enviarImagem(admin);
  const criado = await s.post('/admin/titulos', { tipo: 'filme', nome: 'Sem base', capa_midia_id: capa }, admin);
  const erro = await s.post(`/admin/titulos/${criado.dados.titulo.id}/tmdb`, { tmdb_id: 1 }, admin);
  assert.equal(erro.status, 409);
  assert.equal(erro.dados.detalhes?.motivo, 'sem_tmdb');
});
