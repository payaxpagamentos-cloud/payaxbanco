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
const config = require('../server/config');
const aovivo = require('../server/lib/aovivo');

/** Espera a pasta do canal sumir: a limpeza só acontece depois que o ffmpeg morre de verdade. */
async function esperarLimpeza(canalId, limiteMs = 4000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (!fs.existsSync(aovivo.pastaDoCanal(canalId))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

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

test('conversão é sob demanda: canal cadastrado não gasta nada até alguém assistir', async (t) => {
  const s = await iniciar();
  t.after(() => { aovivo.desligarTudo(); return s.fechar(); });
  const admin = await s.adminLogin();

  const canal = (await s.post('/admin/canais', {
    numero: 50, nome: 'PLAY Sob Demanda', fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/demanda',
  }, admin)).dados.canal;

  // 116 canais ligados o tempo todo não cabem em servidor nenhum: cadastrar não liga nada.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(aovivo.situacao(canal.id).convertendo, false, 'cadastrar um canal não pode ligar a conversão');

  // Quem liga é o assinante que abre o canal — e a resposta já vem com o sinal no ar.
  const cliente = await s.assinante('demanda@exemplo.com.br', { plano: 2 });
  const abrir = await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id }, cliente.token, cliente.comPerfil);
  assert.equal(abrir.status, 201, JSON.stringify(abrir.dados));
  assert.equal(aovivo.situacao(canal.id).convertendo, true);
  assert.equal(aovivo.temSinal(canal.id), true, 'a tela só abre depois do primeiro pedaço');

  // Canal que acabou de ser visto não pode ser desligado no meio do filme de ninguém.
  aovivo.marcarUso(canal.id);
  assert.equal(aovivo.limparOciosos(), 0);

  // Sem ninguém assistindo há tempo demais, sai do ar e devolve a memória e a banda.
  const folga = config.aoVivo.ociosoSegundos;
  config.aoVivo.ociosoSegundos = 0;
  await new Promise((r) => setTimeout(r, 20));   // o corte é por relógio: precisa passar do instante do último uso
  try {
    assert.equal(aovivo.limparOciosos(), 1, 'canal ocioso tem de sair do ar');
  } finally {
    config.aoVivo.ociosoSegundos = folga;
  }
  assert.equal(aovivo.situacao(canal.id).convertendo, false);
  assert.ok(await esperarLimpeza(canal.id), 'o disco do canal ocioso é liberado');

  // E voltar ao canal o põe no ar de novo, sem a operação fazer nada.
  const devolta = await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id }, cliente.token, cliente.comPerfil);
  assert.equal(devolta.status, 201, JSON.stringify(devolta.dados));
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

  // Sob demanda, quem põe o canal no ar é o assinante que o abre.
  const cliente = await s.assinante('aovivo@exemplo.com.br', { plano: 2 });
  const abrir = await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id, dispositivo: 'Smart TV' }, cliente.token, cliente.comPerfil);
  assert.equal(abrir.status, 201, JSON.stringify(abrir.dados));
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

  // O endereço da origem nunca aparece para o assinante, só o nosso.
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
  assert.ok(await esperarLimpeza(canal.id), 'os pedaços do canal desligado saem do disco');
});

test('testar o sinal de um canal no ar lê a conversão, não a origem', async (t) => {
  const s = await iniciar();
  t.after(() => { aovivo.desligarTudo(); return s.fechar(); });
  const admin = await s.adminLogin();

  const canal = (await s.post('/admin/canais', {
    numero: 33, nome: 'PLAY Conferência', fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/conferencia',
  }, admin)).dados.canal;
  const cliente = await s.assinante('confere@exemplo.com.br', { plano: 2 });
  await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id }, cliente.token, cliente.comPerfil);
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

  // O assinante não vê tela preta: a tela nem abre, e vem um recado no lugar.
  const cliente = await s.assinante('falha@exemplo.com.br', { plano: 2 });
  const abrir = await s.post('/play/abrir', { tipo: 'canal', canal_id: id }, cliente.token, cliente.comPerfil);
  assert.equal(abrir.status, 503, JSON.stringify(abrir.dados));
  assert.equal(abrir.dados.detalhes?.motivo ?? abrir.dados.motivo, 'aquecendo');

  // E a operação vê o motivo, com as tentativas de reconexão.
  const sit = aovivo.situacao(id);
  assert.match(sit.erro ?? '', /404|parou/, 'o erro da origem precisa chegar ao painel');
  assert.ok(sit.tentativas >= 1);
  assert.ok(sit.proxima_tentativa, 'tem de haver uma próxima tentativa marcada');

  const noPainel = (await s.get('/admin/canais', admin)).dados.canais.find((c) => c.id === id);
  assert.equal(noPainel.sinal_status, 'falha');
});

test('endereço SRT do fornecedor: o streamid chega inteiro e o latency vira microssegundos', () => {
  // É assim que a lista do fornecedor chega. Dois erros vêm junto, e os dois quebram o canal:
  // o espaço antes de "latency" (que entraria no streamid) e o latency em milissegundos.
  const veio = 'srt://45.190.156.152:5000?streamid=#!::r=GLOBO_HD,m=request latency=2000';
  const vai = aovivo.conferirEndereco(veio);
  assert.equal(vai, 'srt://45.190.156.152:5000?streamid=#!::r=GLOBO_HD,m=request&latency=2000000');
  // O "#" não pode virar fragmento: com new URL() o streamid ficaria vazio e o canal não conectaria.
  assert.match(vai, /streamid=#!::r=GLOBO_HD,m=request(&|$)/);
  // latency já em microssegundos passa intacto.
  assert.match(aovivo.conferirEndereco('srt://1.2.3.4:5000?latency=2000000'), /latency=2000000$/);
});
