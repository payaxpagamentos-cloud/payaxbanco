'use strict';

/**
 * Canal que chega em RTMP ou SRT: o servidor converte para HLS e entrega pelo caminho de
 * reprodução de sempre. Aqui o ffmpeg é o de mentira (test/ffmpeg-falso.js), para o teste
 * rodar em frações de segundo e sem depender de um sinal no ar.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TV_FFMPEG = path.join(__dirname, 'ffmpeg-falso.js');
process.env.TV_AO_VIVO_PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'play-tech-vip-ao-vivo-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const aovivo = require('../server/lib/aovivo');

/** Espera a conversão escrever o primeiro pedaço (o de verdade também leva alguns segundos). */
async function esperarSinal(canalId, limiteMs = 3000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (aovivo.temSinal(canalId)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test('endereço do sinal ao vivo: aceita rtmp e srt, recusa o resto', () => {
  assert.equal(aovivo.conferirEndereco('rtmp://origem.interna/live/canal1'), 'rtmp://origem.interna/live/canal1');
  assert.match(aovivo.conferirEndereco('srt://10.0.0.5:9000?mode=caller'), /^srt:\/\//);
  // Endereço na rede do próprio provedor é legítimo aqui: a origem fica no data center dele.
  assert.match(aovivo.conferirEndereco('rtmp://192.168.0.10/live/canal1'), /^rtmp:\/\//);
  for (const ruim of ['https://origem/live.m3u8', 'file:///etc/passwd', 'concat:/etc/passwd', 'não é endereço']) {
    assert.throws(() => aovivo.conferirEndereco(ruim), /inválido|deve começar/i, `deveria recusar ${ruim}`);
  }
});

test('nome de pedaço fora do formato não vira caminho no disco', () => {
  assert.ok(aovivo.caminhoDoPedaco(7, 'p000012.ts'));
  for (const ruim of ['../../../etc/passwd', 'p000012.ts/../x', 'lista.m3u8', 'p12.ts', '', null, 'p000012.ts%00']) {
    assert.equal(aovivo.caminhoDoPedaco(7, ruim), null, `deveria recusar ${ruim}`);
  }
});

test('canal em RTMP: cadastro, conversão no ar e sinal entregue ao assinante', async (t) => {
  const s = await iniciar();
  t.after(() => { aovivo.desligarTudo(); return s.fechar(); });
  const admin = await s.adminLogin();

  // Endereço de lista .m3u8 não serve para um canal que chega em RTMP, e vice-versa.
  const trocado = await s.post('/admin/canais', { numero: 31, nome: 'Trocado', fonte: 'rtmp', url_hls: 'https://origem.test/live.m3u8' }, admin);
  assert.equal(trocado.status, 422);
  const semEndereco = await s.post('/admin/canais', { numero: 31, nome: 'Sem endereço', fonte: 'rtmp', ativo: true }, admin);
  assert.equal(semEndereco.status, 422, 'canal ligado sem endereço não entra');

  const criado = await s.post('/admin/canais', {
    numero: 31, nome: 'PLAY Esportes', categoria: 'esportes', fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/esportes',
  }, admin);
  assert.equal(criado.status, 201);
  const canal = criado.dados.canal;
  assert.equal(canal.fonte, 'rtmp');

  assert.ok(await esperarSinal(canal.id), 'a conversão deveria ter escrito a lista');

  // O painel mostra a situação da conversão sem precisar perguntar a ninguém. O "ok" só aparece
  // depois que o primeiro pedaço existe: processo de pé, sozinho, não quer dizer sinal no ar.
  const ate = Date.now() + 5000;
  while (Date.now() < ate && s.db.prepare('SELECT sinal_status FROM canais WHERE id = ?').get(canal.id).sinal_status !== 'ok') {
    await new Promise((r) => setTimeout(r, 50));
  }
  const lista = await s.get('/admin/canais', admin);
  const noPainel = lista.dados.canais.find((c) => c.id === canal.id);
  assert.equal(noPainel.ao_vivo.convertendo, true);
  assert.equal(noPainel.ao_vivo.no_ar, true);
  assert.equal(noPainel.sinal_status, 'ok');
  assert.match(noPainel.sinal_detalhe, /convertendo para HLS/);

  // Assinante abre o canal: o endereço da origem nunca aparece, só o nosso.
  const cliente = await s.assinante('aovivo@exemplo.com.br', { plano: 2 });
  const abrir = await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id, dispositivo: 'Smart TV' }, cliente.token, cliente.comPerfil);
  assert.equal(abrir.status, 201);
  assert.equal(abrir.dados.fonte.tipo, 'hls');
  assert.equal(abrir.dados.fonte.nossos_servidores, true);
  assert.doesNotMatch(abrir.dados.fonte.url, /rtmp|origem\.interna/, 'a origem não pode vazar para o player');

  const caminho = abrir.dados.fonte.url.replace(/^.*\/api/, '');
  const m3u8 = await s.req('GET', caminho);
  assert.equal(m3u8.status, 200);
  assert.match(m3u8.headers.get('content-type'), /application\/vnd\.apple\.mpegurl/);
  assert.match(m3u8.dados, /^#EXTM3U/);
  const pedacos = String(m3u8.dados).split('\n').filter((l) => l && !l.startsWith('#'));
  assert.ok(pedacos.length >= 1);
  for (const p of pedacos) assert.match(p, /\/play\/canal\/\d+\/pedaco\/p\d{6}\.ts\?t=/);

  // Pedaço: sai com o token da tela, e só com ele.
  const umPedaco = pedacos[pedacos.length - 1].replace(/^.*\/api/, '');
  const ok = await s.req('GET', umPedaco);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'video/mp2t');

  const semToken = await s.get(`/play/canal/${canal.id}/pedaco/p000000.ts`);
  assert.ok([401, 403].includes(semToken.status), `pedaço sem token não sai (veio ${semToken.status})`);

  const token = new URL(`http://x${umPedaco}`, 'http://x').searchParams.get('t');
  const forjado = await s.get(`/play/canal/${canal.id}/pedaco/${encodeURIComponent('../../../etc/passwd')}?t=${encodeURIComponent(token)}`);
  assert.equal(forjado.status, 403, 'nome de arquivo forjado não lê nada do servidor');

  // Desligar o canal derruba a conversão e limpa o disco.
  const desligado = await s.patch(`/admin/canais/${canal.id}`, { ativo: false }, admin);
  assert.equal(desligado.status, 200);
  assert.equal(aovivo.situacao(canal.id).convertendo, false);
  assert.equal(fs.existsSync(aovivo.pastaDoCanal(canal.id)), false, 'os pedaços do canal desligado saem do disco');
});

test('testar o sinal de um canal no ar lê a conversão, não a origem', async (t) => {
  const s = await iniciar();
  t.after(() => { aovivo.desligarTudo(); return s.fechar(); });
  const admin = await s.adminLogin();

  const canal = (await s.post('/admin/canais', {
    numero: 33, nome: 'PLAY Conferência', fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/conferencia',
  }, admin)).dados.canal;
  assert.ok(await esperarSinal(canal.id));

  // Muito fornecedor aceita só uma conexão por sinal: conferir pela origem derrubaria o canal.
  const r = await s.post(`/admin/canais/${canal.id}/testar`, {}, admin);
  assert.equal(r.status, 200);
  assert.equal(r.dados.lido_de, 'conversao');
});

test('origem fora do ar: a conversão tenta de novo e o painel conta o que houve', async (t) => {
  const s = await iniciar();
  t.after(() => { aovivo.desligarTudo(); return s.fechar(); });
  const admin = await s.adminLogin();

  const criado = await s.post('/admin/canais', {
    numero: 32, nome: 'PLAY Falha', fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/falha',
  }, admin);
  assert.equal(criado.status, 201);
  const id = criado.dados.canal.id;

  // O ffmpeg de mentira sai com erro para este endereço; o servidor anota e agenda a volta.
  const fim = Date.now() + 3000;
  let sit = aovivo.situacao(id);
  while (Date.now() < fim && !sit.erro) {
    await new Promise((r) => setTimeout(r, 25));
    sit = aovivo.situacao(id);
  }
  assert.match(sit.erro ?? '', /404|parou/, 'o erro da origem precisa chegar ao painel');
  assert.ok(sit.tentativas >= 1);
  assert.ok(sit.proxima_tentativa, 'tem de haver uma próxima tentativa marcada');

  const noPainel = (await s.get('/admin/canais', admin)).dados.canais.find((c) => c.id === id);
  assert.equal(noPainel.sinal_status, 'falha');

  // Assinante não vê tela preta: recebe o recado de que o canal está entrando no ar.
  const cliente = await s.assinante('falha@exemplo.com.br', { plano: 2 });
  const abrir = await s.post('/play/abrir', { tipo: 'canal', canal_id: id }, cliente.token, cliente.comPerfil);
  assert.equal(abrir.status, 503);
  assert.equal(abrir.dados.detalhes?.motivo ?? abrir.dados.motivo, 'aquecendo');
});
