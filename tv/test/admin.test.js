'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, videoFalso } = require('./helpers');

test('envio de vídeo em pedaços: ordem, tamanho e formato', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const conteudo = videoFalso(3000);

  const abertura = await s.post('/admin/midias/video', { nome: 'filme.mp4', tamanho: conteudo.length, duracao_s: 120, largura: 1920, altura: 1080 }, admin);
  assert.equal(abertura.status, 201);
  const id = abertura.dados.midia.id;

  // Pedaço fora de ordem é recusado, dizendo onde o servidor parou.
  const furo = await s.put(`/admin/midias/${id}/parte?offset=2000`, conteudo.subarray(2000), admin);
  assert.equal(furo.status, 409);
  assert.equal(furo.dados.detalhes.recebido, 0);

  // Concluir antes da hora não deixa o arquivo pronto.
  const cedo = await s.post(`/admin/midias/${id}/concluir`, {}, admin);
  assert.equal(cedo.status, 409);

  const p1 = await s.put(`/admin/midias/${id}/parte?offset=0`, conteudo.subarray(0, 1500), admin);
  assert.equal(p1.dados.recebido, 1500);
  // Repetir o mesmo pedaço (rede caiu) é aceito.
  assert.equal((await s.put(`/admin/midias/${id}/parte?offset=0`, conteudo.subarray(0, 1500), admin)).dados.recebido, 1500);
  const p2 = await s.put(`/admin/midias/${id}/parte?offset=1500`, conteudo.subarray(1500), admin);
  assert.equal(p2.dados.concluido, true);

  const fim = await s.post(`/admin/midias/${id}/concluir`, { duracao_s: 120 }, admin);
  assert.equal(fim.status, 200);
  assert.equal(fim.dados.midia.mime, 'video/mp4');
  assert.equal(fim.dados.midia.qualidade, 'hd');
  assert.equal(fim.dados.midia.status, 'pronta');

  // Passar do tamanho combinado é recusado.
  const outro = await s.post('/admin/midias/video', { nome: 'x.mp4', tamanho: 100 }, admin);
  const grande = await s.put(`/admin/midias/${outro.dados.midia.id}/parte?offset=0`, Buffer.alloc(200), admin);
  assert.equal(grande.status, 413);
});

test('arquivo que não é vídeo é recusado pelo conteúdo, não pelo nome', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const lixo = Buffer.from('isto é um texto com extensão de vídeo'.repeat(10));
  const abertura = await s.post('/admin/midias/video', { nome: 'filme.mp4', tamanho: lixo.length }, admin);
  await s.put(`/admin/midias/${abertura.dados.midia.id}/parte?offset=0`, lixo, admin);
  const fim = await s.post(`/admin/midias/${abertura.dados.midia.id}/concluir`, {}, admin);
  assert.equal(fim.status, 415);
  assert.match(fim.dados.erro, /MP4/);

  const imagem = await s.post('/admin/midias/imagem?nome=capa.png', lixo, admin, { headers: { 'Content-Type': 'image/png' } });
  assert.equal(imagem.status, 415);

  const legenda = await s.post('/admin/midias/legenda?nome=l.vtt', Buffer.from('1\n00:00 --> 00:01\noi'), admin, { headers: { 'Content-Type': 'text/vtt' } });
  assert.equal(legenda.status, 415);
  assert.match(legenda.dados.erro, /WEBVTT/);

  const boa = await s.post('/admin/midias/legenda?nome=l.vtt', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOlá'), admin, { headers: { 'Content-Type': 'text/vtt' } });
  assert.equal(boa.status, 201);
});

test('arquivo em uso não pode ser apagado', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const video = await s.enviarVideo(admin);
  const titulo = await s.post('/admin/titulos', { tipo: 'filme', nome: 'Em Uso', video_midia_id: video }, admin);
  assert.equal((await s.del(`/admin/midias/${video}`, admin)).status, 409);
  await s.patch(`/admin/titulos/${titulo.dados.titulo.id}`, { video_midia_id: null }, admin);
  assert.equal((await s.del(`/admin/midias/${video}`, admin)).status, 204);
});

test('curadoria cuida do conteúdo, mas não do financeiro', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const criada = await s.post('/admin/equipe', { nome: 'Curadoria', email: 'curadoria@payaxtv.com.br', senha: 'curadoria123', perfil: 'curador' }, admin);
  assert.equal(criada.status, 201);
  const curador = await s.login('curadoria@payaxtv.com.br', 'curadoria123');

  assert.equal((await s.get('/admin/canais', curador)).status, 200);
  assert.equal((await s.post('/admin/canais', { numero: 4, nome: 'Canal', url_hls: 'https://origem.test/x.m3u8' }, curador)).status, 201);
  assert.equal((await s.get('/admin/assinantes', curador)).status, 403);
  assert.equal((await s.get('/admin/faturas', curador)).status, 403);
  assert.equal((await s.get('/admin/config', curador)).status, 403);
  assert.equal((await s.get('/admin/relatorios/financeiro', curador)).status, 403);
  // O painel do curador vem sem os números de receita.
  const painel = await s.get('/admin/painel', curador);
  assert.equal(painel.status, 200);
  assert.equal(painel.dados.receita, null);
});

test('assinante não entra no painel', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('curioso@exemplo.com.br', { plano: 1 });
  for (const rota of ['/admin/painel', '/admin/canais', '/admin/titulos', '/admin/assinantes']) {
    assert.equal((await s.get(rota, cliente.token)).status, 403, rota);
  }
});

test('equipe: sempre sobra um administrador ativo', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const eu = (await s.get('/auth/me', admin)).dados.usuario;
  assert.equal((await s.patch(`/admin/equipe/${eu.id}`, { ativo: false }, admin)).status, 409, 'não desativa a si mesmo');
  assert.equal((await s.patch(`/admin/equipe/${eu.id}`, { perfil: 'curador' }, admin)).status, 409, 'não rebaixa a si mesmo');

  const outro = await s.post('/admin/equipe', { nome: 'Segundo Admin', email: 'admin2@payaxtv.com.br', senha: 'segundo123', perfil: 'admin' }, admin);
  assert.equal((await s.patch(`/admin/equipe/${outro.dados.usuario.id}`, { ativo: false }, admin)).status, 200);
});

test('perfis de visualização: limite do plano, PIN e perfil principal', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('perfis@exemplo.com.br', { plano: 1 }); // Essencial: 2 perfis
  const segundo = await s.post('/conta/perfis', { nome: 'Visitas' }, cliente.token);
  assert.equal(segundo.status, 201);
  const terceiro = await s.post('/conta/perfis', { nome: 'Sobrando' }, cliente.token);
  assert.equal(terceiro.status, 409, 'o plano Essencial permite 2 perfis');

  const principal = (await s.get('/conta/perfis', cliente.token)).dados.perfis.find((p) => p.principal);
  assert.equal((await s.del(`/conta/perfis/${principal.id}`, cliente.token)).status, 409);

  // Com PIN, o perfil só vale com a chave que vem ao digitar o PIN.
  await s.patch(`/conta/perfis/${segundo.dados.perfil.id}`, { pin: '4321' }, cliente.token);
  const semChave = await s.get('/tv/home', cliente.token, { headers: { 'X-Perfil': String(segundo.dados.perfil.id) } });
  assert.equal(semChave.status, 423);
  assert.equal(semChave.dados.detalhes.pin, true);

  assert.equal((await s.post(`/conta/perfis/${segundo.dados.perfil.id}/abrir`, { pin: '0000' }, cliente.token)).status, 422);
  const aberto = await s.post(`/conta/perfis/${segundo.dados.perfil.id}/abrir`, { pin: '4321' }, cliente.token);
  assert.equal(aberto.status, 200);
  const comChave = await s.get('/tv/home', cliente.token, { headers: { 'X-Perfil': String(segundo.dados.perfil.id), 'X-Perfil-Chave': aberto.dados.chave } });
  assert.equal(comChave.status, 200);

  // Tirar o PIN exige o PIN atual.
  assert.equal((await s.patch(`/conta/perfis/${segundo.dados.perfil.id}`, { pin: null }, cliente.token)).status, 422);
  assert.equal((await s.patch(`/conta/perfis/${segundo.dados.perfil.id}`, { pin: null, pin_atual: '4321' }, cliente.token)).status, 200);
});

test('a operação coloca o assinante num plano e dá cortesia', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const cliente = await s.assinante('cortesia@exemplo.com.br');
  const u = (await s.get('/admin/assinantes', admin)).dados.assinantes[0];

  const r = await s.post(`/admin/assinantes/${u.id}/assinatura`, { plano_id: 2, acesso_ate: '2030-12-31' }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.dados.assinatura.ativa, true);
  assert.equal(r.dados.assinatura.acesso_ate, '2030-12-31');
  assert.equal((await s.get('/tv/home', cliente.token, cliente.comPerfil)).status, 200);

  // Desativar a conta corta o acesso na hora.
  await s.patch(`/admin/assinantes/${u.id}`, { ativo: false }, admin);
  assert.equal((await s.get('/tv/home', cliente.token, cliente.comPerfil)).status, 401);
});

test('a auditoria registra o que a equipe faz', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  await s.post('/admin/canais', { numero: 4, nome: 'Canal Auditado', url_hls: 'https://origem.test/x.m3u8' }, admin);
  const { registros } = (await s.get('/admin/auditoria', admin)).dados;
  const criado = registros.find((r) => r.acao === 'canal_criado');
  assert.ok(criado, 'a criação do canal entra na auditoria');
  assert.match(criado.detalhes, /Canal Auditado/);
  assert.equal(criado.usuario, 'Operação PayAx TV');
});

test('saúde e configuração pública', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  assert.deepEqual((await s.get('/saude')).dados, { ok: true });
  const publico = await s.get('/publico');
  assert.equal(publico.dados.marca, 'PayAx TV');
  assert.equal(publico.dados.planos.length, 3);
  assert.equal((await s.get('/rota-que-nao-existe')).status, 404);
});
