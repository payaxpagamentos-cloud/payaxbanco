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
  t.after(async () => { await aovivo.desligarTudo(); await s.fechar(); });
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
  t.after(async () => { await aovivo.desligarTudo(); await s.fechar(); });
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
  t.after(async () => { await aovivo.desligarTudo(); await s.fechar(); });
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
  t.after(async () => { await aovivo.desligarTudo(); await s.fechar(); });
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

test('lista do fornecedor: número de São Paulo na TV aberta, tema e faixa no resto', () => {
  const fornecedor = require('../server/lib/canais-fornecedor');
  const texto = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'canais-fornecedor.txt'), 'utf8');
  const { canais, recusados } = fornecedor.montar(texto);

  assert.equal(recusados.length, 0, 'nenhum endereço da lista pode ser recusado');
  assert.equal(canais.length, 116);

  // Os números que a casa de São Paulo já tem na cabeça.
  const numeroDe = (nome) => canais.find((c) => c.nome === nome)?.numero;
  assert.equal(numeroDe('TV Cultura'), 2);
  assert.equal(numeroDe('SBT'), 4);
  assert.equal(numeroDe('Globo'), 5);
  assert.equal(numeroDe('Record'), 7);
  assert.equal(numeroDe('RedeTV!'), 9);
  assert.equal(numeroDe('Gazeta'), 11);
  assert.equal(numeroDe('Band'), 13);

  // Número é único: é o que o assinante digita no controle.
  assert.equal(new Set(canais.map((c) => c.numero)).size, canais.length);

  // As faixas por tema deixaram de valer quando a numeração passou a ser a da Claro São Paulo:
  // lá o critério é a grade da operadora, não o tema. O que não pode é canal sem número.
  for (const c of canais) assert.ok(Number.isInteger(c.numero) && c.numero > 0, `${c.nome} sem número`);
  // Canal adulto não nasce liberado.
  assert.equal(canais.find((c) => c.nome === 'WooHoo').classificacao, 18);
  // E o endereço de todo canal sai pronto para o conversor.
  for (const c of canais) assert.match(c.endereco, /^srt:\/\/[\d.]+:\d+\?streamid=#!::r=[^&]+&latency=2000000$/);
});

test('numeração: abertos na antena de SP, fechados na grade da Claro', () => {
  const fornecedor = require('../server/lib/canais-fornecedor');
  const texto = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'canais-fornecedor.txt'), 'utf8');
  const { canais } = fornecedor.montar(texto);
  const n = (nome) => canais.find((c) => c.nome === nome)?.numero;

  // TV aberta: os números da antena, que é o que a casa tem na cabeça.
  assert.equal(n('TV Cultura'), 2);
  assert.equal(n('Globo'), 5);
  assert.equal(n('Band'), 13);

  // Fechados: a grade da Claro São Paulo, conferida com os quatro exemplos da operação.
  assert.equal(n('SporTV'), 39);
  assert.equal(n('SporTV 2'), 38);
  assert.equal(n('SporTV 3'), 37);
  assert.equal(n('Globo News'), 40);

  // Nenhum canal fechado pode cair na faixa da TV aberta: é o que faz os dois padrões conviverem.
  for (const c of canais.filter((x) => x.categoria !== 'aberta')) {
    assert.ok(c.numero < 2 || c.numero > 13, `${c.nome} (${c.numero}) invade a faixa da TV aberta`);
  }
  // E o número continua único — é o que o assinante digita no controle.
  assert.equal(new Set(canais.map((c) => c.numero)).size, canais.length);
});

test('o canal só é entregue com folga de buffer, não no primeiro pedaço', async (t) => {
  // Por que este teste existe: a conversão escreve a lista assim que fecha o PRIMEIRO pedaço,
  // com 4 segundos de vídeo. Entregar o canal ali deixava o player colado na ponta, sem reserva,
  // correndo atrás de um processo que produz 4 segundos a cada 4 segundos — e travando na
  // primeira oscilação de rede. Foi o que o assinante viu na prática.
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'play-tech-vip-folga-'));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }));

  const lista = (quantos) => [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
    ...Array.from({ length: quantos }, (_, i) => `#EXTINF:4.000,\np${String(i).padStart(6, '0')}.ts`),
    '',
  ].join('\n');

  const antes = config.aoVivo.pasta;
  config.aoVivo.pasta = pasta;
  t.after(() => { config.aoVivo.pasta = antes; });
  fs.mkdirSync(path.join(pasta, '7'), { recursive: true });
  const arquivo = path.join(pasta, '7', 'lista.m3u8');

  // Lista vazia: nem sinal, nem folga.
  fs.writeFileSync(arquivo, '');
  assert.equal(aovivo.pedacosNaLista(7), 0);
  assert.equal(aovivo.daParaAssistir(7), false);

  // Um e dois pedaços: HÁ sinal, mas ainda não dá para assistir sem travar. É a distinção que
  // faltava — "tem sinal" e "dá para assistir" não são a mesma coisa.
  for (const n of [1, 2]) {
    fs.writeFileSync(arquivo, lista(n));
    assert.equal(aovivo.pedacosNaLista(7), n);
    assert.equal(aovivo.temSinal(7), true, `com ${n} pedaço(s) já há sinal`);
    assert.equal(aovivo.daParaAssistir(7), false, `com ${n} pedaço(s) o player travaria`);
  }

  // Três pedaços são os 12s que o hls.js procura (liveSyncDurationCount: 3) e o que o HLS
  // recomenda: começar a tocar a três pedaços da ponta.
  fs.writeFileSync(arquivo, lista(3));
  assert.equal(aovivo.daParaAssistir(7), true);

  // Só conta pedaço de verdade: comentário e cabeçalho não viram folga.
  fs.writeFileSync(arquivo, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n# p000000.ts\n');
  assert.equal(aovivo.pedacosNaLista(7), 0, 'linha comentada não é pedaço');
});

test('conversão: copia o que dá, converte só o que precisa', (t) => {
  // Por que este teste existe: a conversão era `-c copy` cego. Canal com áudio em AC-3 — comum
  // em TV brasileira — era copiado como estava e saía MUDO no Android e no Chrome. Pior: o teste
  // de sinal marcava esse canal como falha, e "testar e ligar" o DESLIGAVA. Canal bom fora do ar
  // por um detalhe que custa 1% de um núcleo resolver.
  const modo = (video, audio) => aovivo.modoDeConversao({ sinal_video: video, sinal_audio: audio }).join(' ');

  // O caso bom: nada a fazer, qualidade idêntica à da origem.
  assert.equal(modo('h264', 'aac'), '-c:v copy -c:a copy');
  // H.265 também passa direto — toca em aparelho novo, e recodificar seria pior.
  assert.equal(modo('hevc', 'aac'), '-c:v copy -c:a copy');

  // Áudio que o Android e o Chrome não tocam: vídeo intocado, áudio convertido.
  for (const ruim of ['ac3', 'eac3', 'mp2', 'opus', 'AC3']) {
    assert.equal(modo('h264', ruim), '-c:v copy -c:a aac -b:a 128k -ac 2', `áudio ${ruim} precisa virar AAC`);
  }
  // mp3 toca em tudo: não se mexe no que já está bom.
  assert.equal(modo('h264', 'mp3'), '-c:v copy -c:a copy');

  // Canal nunca testado (sem codec guardado): copia, que é o comportamento de sempre. Mexer no
  // escuro seria pior — o teste de sinal preenche isso na primeira passada.
  assert.equal(modo(null, null), '-c:v copy -c:a copy');
  assert.equal(modo('', ''), '-c:v copy -c:a copy');

  // Vídeo que o HLS não aceita: por padrão NÃO recodifica. Custa quase um núcleo por canal,
  // contra 1,8% do remux — com 116 canais isso não cabe em servidor nenhum.
  assert.match(modo('mpeg2video', 'aac'), /^-c:v copy/, 'sem a chave ligada, não recodifica vídeo');

  const antes = config.aoVivo.recodificarVideo;
  config.aoVivo.recodificarVideo = true;
  t.after(() => { config.aoVivo.recodificarVideo = antes; });
  assert.match(modo('mpeg2video', 'aac'), /-c:v libx264/, 'com a chave ligada, recodifica');
  assert.match(modo('mpeg2video', 'ac3'), /-c:v libx264 .*-c:a aac/, 'vídeo e áudio quando os dois precisam');
  assert.match(modo('h264', 'aac'), /^-c:v copy/, 'a chave não estraga quem estava bom');
});

test('canal quente fica de pé e não é desligado por ociosidade', async (t) => {
  // Por que isto existe: "sob demanda" economiza memória, mas cobra o preço justamente nos
  // canais mais vistos — quem abre a Globo espera o canal subir toda vez que ele esfria. Com a
  // TV aberta marcada como quente, esses abrem na hora, e o resto continua sob demanda.
  const s = await iniciar();
  t.after(async () => { await aovivo.desligarTudo(); await s.fechar(); });
  const admin = await s.adminLogin();

  const quente = (await s.post('/admin/canais', { numero: 5, nome: 'Globo Teste', fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/globo', ativo: true }, admin)).dados.canal;
  const frio = (await s.post('/admin/canais', { numero: 77, nome: 'Canal Frio', fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/frio', ativo: true }, admin)).dados.canal;

  const antes = config.aoVivo.quentes;
  config.aoVivo.quentes = [5];
  t.after(() => { config.aoVivo.quentes = antes; });

  // Sem ninguém assistindo, o quente sobe sozinho e o frio não.
  aovivo.sincronizar(s.db);
  await new Promise((r) => { setTimeout(r, 400); });
  assert.equal(aovivo.situacao(quente.id).convertendo, true, 'canal quente sobe sem ninguém pedir');
  assert.equal(aovivo.situacao(frio.id).convertendo, false, 'canal comum continua sob demanda');

  // E a limpeza de ociosos não pode derrubá-lo, por mais tempo que passe.
  aovivo.marcarUso(frio.id);
  await aovivo.garantir(frio, s.db, { esperarMs: 3000 });
  assert.equal(aovivo.situacao(frio.id).convertendo, true);
  const folga = config.aoVivo.ociosoSegundos;
  config.aoVivo.ociosoSegundos = -1;            // tudo parece ocioso
  t.after(() => { config.aoVivo.ociosoSegundos = folga; });
  const desligados = aovivo.limparOciosos();
  assert.equal(aovivo.situacao(quente.id).convertendo, true, 'quente sobrevive à limpeza');
  assert.equal(aovivo.situacao(frio.id).convertendo, false, 'frio sai, como sempre saiu');
  assert.equal(desligados, 1);
});

test('canal religado no meio do desligamento não perde a pasta nova', async (t) => {
  // Por que isto existe: `desligar` mata o ffmpeg e, QUANDO ELE MORRE, apaga a pasta do canal.
  // Se o canal voltar a ligar nesse intervalo — e a rota de editar canal faz desligar seguido de
  // sincronizar, um atrás do outro —, a pasta apagada passava a ser a da conversão NOVA. O canal
  // subia e, milissegundos depois, ficava sem nenhum pedaço: tela preta num canal que acabou de
  // ser ligado pela própria operação.
  const s = await iniciar();
  t.after(async () => { await aovivo.desligarTudo(); await s.fechar(); });
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 61, nome: 'Religado', fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/religado', ativo: true }, admin)).dados.canal;

  await aovivo.garantir(canal, s.db, { esperarMs: 4000 });
  assert.equal(aovivo.temSinal(canal.id), true, 'o canal subiu');

  // Desliga e religa na sequência, como a rota faz.
  aovivo.desligar(canal.id);
  aovivo.ligar(canal, s.db);

  // Dá tempo de o processo velho morrer e disparar a limpeza dele.
  await new Promise((r) => { setTimeout(r, 1200); });

  assert.equal(aovivo.situacao(canal.id).convertendo, true, 'a conversão nova continua de pé');
  assert.equal(aovivo.temSinal(canal.id), true, 'e a pasta dela não foi apagada pelo processo velho');
});
