'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const relay = require('../server/lib/relay');
const player = require('../server/lib/player');

async function filmePublicado(s, admin, nome = 'A Noite do Sertão') {
  const capa = await s.enviarImagem(admin);
  const video = await s.enviarVideo(admin, { tamanho: 16_384, duracao: 5400 });
  const r = await s.post('/admin/titulos', { tipo: 'filme', nome, capa_midia_id: capa, video_midia_id: video, duracao_s: 5400 }, admin);
  await s.post(`/admin/titulos/${r.dados.titulo.id}/situacao`, { situacao: 'publicado' }, admin);
  return { titulo: r.dados.titulo, video };
}

test('vídeo sob demanda: só com token, e com suporte a Range', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const { titulo, video } = await filmePublicado(s, admin);
  const cliente = await s.assinante('play@exemplo.com.br', { plano: 2 });

  const abrir = await s.post('/play/abrir', { tipo: 'filme', titulo_id: titulo.id, dispositivo: 'Smart TV' }, cliente.token, cliente.comPerfil);
  assert.equal(abrir.status, 201);
  assert.equal(abrir.dados.fonte.tipo, 'video');
  assert.match(abrir.dados.download, /\/play\/baixar\//, 'o plano Família inclui download');

  const caminho = abrir.dados.fonte.url.replace(/^.*\/api/, '');
  const inteiro = await s.req('GET', caminho);
  assert.equal(inteiro.status, 200);
  assert.equal(inteiro.headers.get('accept-ranges'), 'bytes');
  assert.equal(inteiro.headers.get('content-length'), '16384');

  const trecho = await s.req('GET', caminho, undefined, undefined, { headers: { Range: 'bytes=100-199' } });
  assert.equal(trecho.status, 206);
  assert.equal(trecho.headers.get('content-range'), 'bytes 100-199/16384');
  assert.equal(trecho.headers.get('content-length'), '100');

  const fim = await s.req('GET', caminho, undefined, undefined, { headers: { Range: 'bytes=-50' } });
  assert.equal(fim.headers.get('content-range'), 'bytes 16334-16383/16384');

  const foraDaFaixa = await s.req('GET', caminho, undefined, undefined, { headers: { Range: 'bytes=99999-' } });
  assert.equal(foraDaFaixa.status, 416);

  assert.equal((await s.get(`/play/video/${video}`)).status, 401, 'sem token não toca');
  const adulterado = `${caminho.split('?')[0]}?t=${encodeURIComponent('abc.def')}`;
  assert.equal((await s.get(adulterado)).status, 401, 'token adulterado não toca');
});

test('o token de um vídeo não serve para outro', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const a = await filmePublicado(s, admin, 'Filme A');
  const b = await filmePublicado(s, admin, 'Filme B');
  const cliente = await s.assinante('troca@exemplo.com.br', { plano: 2 });
  const abrir = await s.post('/play/abrir', { tipo: 'filme', titulo_id: a.titulo.id }, cliente.token, cliente.comPerfil);
  const token = new URL(`http://x${abrir.dados.fonte.url}`).searchParams.get('t');
  const r = await s.get(`/play/video/${b.video}?t=${encodeURIComponent(token)}`);
  assert.equal(r.status, 403);
});

test('telas simultâneas respeitam o plano e podem ser liberadas', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const { titulo } = await filmePublicado(s, admin);
  const cliente = await s.assinante('telas@exemplo.com.br', { plano: 1 }); // Essencial: 1 tela

  const primeira = await s.post('/play/abrir', { tipo: 'filme', titulo_id: titulo.id, dispositivo: 'Sala' }, cliente.token, cliente.comPerfil);
  assert.equal(primeira.status, 201);

  const segunda = await s.post('/play/abrir', { tipo: 'filme', titulo_id: titulo.id, dispositivo: 'Quarto' }, cliente.token, cliente.comPerfil);
  assert.equal(segunda.status, 409);
  assert.equal(segunda.dados.detalhes.telas, 1);
  assert.equal(segunda.dados.detalhes.em_uso[0].dispositivo, 'Sala');

  const telas = await s.get('/conta/telas', cliente.token);
  assert.equal(telas.dados.telas.length, 1);

  await s.post('/conta/telas/encerrar', {}, cliente.token);
  const depois = await s.post('/play/abrir', { tipo: 'filme', titulo_id: titulo.id, dispositivo: 'Quarto' }, cliente.token, cliente.comPerfil);
  assert.equal(depois.status, 201);

  // A tela encerrada não recebe mais sinal de vida.
  const ping = await s.post('/play/ping', { sessao_id: primeira.dados.sessao_id, segundos: 10 }, cliente.token);
  assert.equal(ping.status, 409);
});

test('sinal de vida guarda a audiência e o ponto de retomada', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const { titulo } = await filmePublicado(s, admin);
  const cliente = await s.assinante('ping@exemplo.com.br', { plano: 2 });
  const abrir = await s.post('/play/abrir', { tipo: 'filme', titulo_id: titulo.id }, cliente.token, cliente.comPerfil);

  await s.post('/play/ping', { sessao_id: abrir.dados.sessao_id, segundos: 600, posicao: 600, duracao: 5400 }, cliente.token);
  await s.post('/play/fechar', { sessao_id: abrir.dados.sessao_id }, cliente.token);

  const sessao = s.db.prepare('SELECT * FROM sessoes_player WHERE id = ?').get(abrir.dados.sessao_id);
  assert.equal(sessao.segundos, 600);
  assert.ok(sessao.encerrada_em);

  // Ao abrir de novo, volta um pouco antes de onde parou (folga de 5 segundos).
  const denovo = await s.post('/play/abrir', { tipo: 'filme', titulo_id: titulo.id }, cliente.token, cliente.comPerfil);
  assert.equal(denovo.dados.retomar_s, 595);

  const painel = await s.get('/admin/relatorios/audiencia', admin);
  assert.ok(painel.dados.titulos.some((x) => x.nome === titulo.nome && x.minutos === 10));
});

test('download só nos planos que incluem', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const { titulo } = await filmePublicado(s, admin);

  const semDownload = await s.assinante('sem-download@exemplo.com.br', { plano: 1 });
  const a = await s.post('/play/abrir', { tipo: 'filme', titulo_id: titulo.id }, semDownload.token, semDownload.comPerfil);
  assert.equal(a.dados.download, null);

  const comDownload = await s.assinante('com-download@exemplo.com.br', { plano: 3 });
  const b = await s.post('/play/abrir', { tipo: 'filme', titulo_id: titulo.id }, comDownload.token, comDownload.comPerfil);
  assert.ok(b.dados.download);
  const baixado = await s.req('GET', b.dados.download.replace(/^.*\/api/, ''));
  assert.equal(baixado.status, 200);
  assert.match(baixado.headers.get('content-disposition'), /attachment/);
});

test('canal ao vivo: a lista HLS exige token do canal certo', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 4, nome: 'PLAY 4', url_hls: 'https://origem.test/live.m3u8' }, admin)).dados.canal;
  const outro = (await s.post('/admin/canais', { numero: 9, nome: 'Outro', url_hls: 'https://origem.test/outro.m3u8' }, admin)).dados.canal;
  const cliente = await s.assinante('vivo@exemplo.com.br', { plano: 2 });

  const abrir = await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id }, cliente.token, cliente.comPerfil);
  assert.equal(abrir.status, 201);
  assert.equal(abrir.dados.ao_vivo, true);
  assert.equal(abrir.dados.fonte.nossos_servidores, true);
  assert.match(abrir.dados.fonte.url, new RegExp(`/play/canal/${canal.id}/lista.m3u8`));

  const token = new URL(`http://x${abrir.dados.fonte.url}`).searchParams.get('t');
  assert.equal((await s.get(`/play/canal/${canal.id}/lista.m3u8`)).status, 401, 'sem token');
  assert.equal((await s.get(`/play/canal/${outro.id}/lista.m3u8?t=${encodeURIComponent(token)}`)).status, 403, 'token de outro canal');

  // Endereço de segmento tem de vir assinado por nós.
  const inventado = await s.get(`/play/canal/${canal.id}/segmento?t=${encodeURIComponent(token)}&u=aHR0cHM6Ly9tYXUudGVzdC94LnRz.assinaturafalsa`);
  assert.equal(inventado.status, 403);
});

test('reescrita da lista HLS aponta tudo para o nosso servidor', () => {
  const canal = { id: 3 };
  const opcoes = { canal, playToken: 'TOKEN', baseApi: '/tv/api', urlDaLista: 'https://origem.test/live/master.m3u8' };

  const mestre = relay.reescrever([
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    '360p/index.m3u8',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/pt.m3u8"',
  ].join('\n'), opcoes);
  assert.ok(!mestre.includes('origem.test'), 'a origem não aparece para o assinante');
  assert.match(mestre, /\/tv\/api\/play\/canal\/3\/lista\.m3u8\?t=TOKEN&u=/);

  const midia = relay.reescrever([
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://origem.test/chave.key"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:6.0,',
    'seg1.ts',
    '#EXTINF:6.0,',
    '/absoluto/seg2.ts',
  ].join('\n'), opcoes);
  const linhas = midia.split('\n');
  assert.match(linhas[1], /#EXT-X-KEY:METHOD=AES-128,URI="\/tv\/api\/play\/canal\/3\/segmento\?/);
  assert.match(linhas[4], /\/tv\/api\/play\/canal\/3\/segmento\?t=TOKEN&u=/);
  // O endereço assinado volta exatamente ao endereço de origem (relativo resolvido).
  const u = new URL(`http://x${linhas[4]}`).searchParams.get('u');
  assert.equal(relay.lerUrlAssinada(3, u), 'https://origem.test/live/seg1.ts');
  const u2 = new URL(`http://x${linhas[6]}`).searchParams.get('u');
  assert.equal(relay.lerUrlAssinada(3, u2), 'https://origem.test/absoluto/seg2.ts');
  assert.equal(relay.lerUrlAssinada(4, u), null, 'a assinatura vale só para aquele canal');

  assert.throws(() => relay.reescrever('isto não é uma lista', opcoes), /lista HLS/);
});

test('a transmissão recusa endereços de rede interna', async () => {
  for (const url of ['http://127.0.0.1:8080/x.m3u8', 'http://10.0.0.5/x.m3u8', 'http://169.254.169.254/latest/meta-data',
    'http://192.168.0.10/x.m3u8', 'http://[::1]/x.m3u8']) {
    await assert.rejects(() => relay.conferirEndereco(url), /rede interna|inválido/i, url);
  }
  // Endereço público passa na conferência de formato.
  assert.ok(await relay.conferirEndereco('https://8.8.8.8/lista.m3u8'));
});

test('token de reprodução expirado não vale', () => {
  const original = Date.now;
  const token = player.emitirToken({ s: 1, u: 1, p: 1, t: 'filme', m: 5 });
  Date.now = () => original() + 7 * 60 * 60 * 1000; // passa das 6 horas de validade
  assert.equal(player.lerToken(token), null);
  Date.now = original;
  assert.ok(player.lerToken(token));
});

test('qualidades: o plano manda até onde o assinante pode subir', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const capa = await s.enviarImagem(admin);
  const video4k = await s.enviarVideo(admin, { tamanho: 20_000, duracao: 600, altura: 2160 });
  const r = await s.post('/admin/titulos', { tipo: 'filme', nome: 'Noite em 4K', capa_midia_id: capa, video_midia_id: video4k, duracao_s: 600 }, admin);
  const id = r.dados.titulo.id;

  const videoFull = await s.enviarVideo(admin, { tamanho: 14_000, duracao: 600, altura: 1080 });
  const videoHd = await s.enviarVideo(admin, { tamanho: 9000, duracao: 600, altura: 720 });
  assert.equal((await s.post('/admin/versoes', { titulo_id: id, midia_id: videoHd, qualidade: 'hd' }, admin)).status, 201);
  // Sem dizer a qualidade, vale a altura do arquivo.
  const auto = await s.post('/admin/versoes', { titulo_id: id, midia_id: videoFull }, admin);
  assert.equal(auto.dados.versao.qualidade, 'fullhd');
  await s.post(`/admin/titulos/${id}/situacao`, { situacao: 'publicado' }, admin);

  // Plano Essencial: só até HD.
  const essencial = await s.assinante('hd@exemplo.com.br', { plano: 1 });
  const a = await s.post('/play/abrir', { tipo: 'filme', titulo_id: id }, essencial.token, essencial.comPerfil);
  assert.equal(a.dados.fonte.qualidade, 'hd', 'toca a melhor que o plano alcança');
  assert.deepEqual(a.dados.qualidades.map((q) => q.qualidade), ['4k', 'fullhd', 'hd']);
  const quatroK = a.dados.qualidades.find((q) => q.qualidade === '4k');
  assert.equal(quatroK.bloqueada, true);
  assert.equal(quatroK.url, null, 'a qualidade bloqueada aparece no menu, mas sem endereço');
  const tokenEssencial = new URL(`http://x${a.dados.fonte.url}`).searchParams.get('t');
  assert.equal((await s.get(`/play/video/${video4k}?t=${encodeURIComponent(tokenEssencial)}`)).status, 403,
    'o token do plano HD não abre o arquivo em 4K');

  // Plano Cinema 4K: abre tudo e troca de qualidade com o mesmo token.
  const cinema = await s.assinante('ultra@exemplo.com.br', { plano: 3 });
  const b = await s.post('/play/abrir', { tipo: 'filme', titulo_id: id }, cinema.token, cinema.comPerfil);
  assert.equal(b.dados.fonte.qualidade, '4k');
  assert.ok(b.dados.qualidades.every((q) => !q.bloqueada));
  const paraFullHd = b.dados.qualidades.find((q) => q.qualidade === 'fullhd').url;
  const troca = await s.req('GET', paraFullHd.replace(/^.*\/api/, ''));
  assert.equal(troca.status, 200, 'trocar de qualidade não precisa de token novo');
  assert.equal(troca.headers.get('content-length'), '14000');

  // A ficha do catálogo mostra as qualidades disponíveis.
  const ficha = await s.get(`/tv/titulos/${r.dados.titulo.slug}`, cinema.token, cinema.comPerfil);
  assert.deepEqual(ficha.dados.titulo.qualidades, ['4k', 'fullhd', 'hd']);
});
