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

  const c = await s.post('/admin/canais', { numero: 4, nome: 'PLAY 4 Aberta', categoria: 'aberta', url_hls: 'https://origem.test/live.m3u8' }, admin);
  assert.equal(c.status, 201);
  assert.equal(c.dados.canal.slug, 'play-4-aberta');
  assert.equal(c.dados.canal.relay, 1, 'por padrão o sinal passa pelo nosso servidor');

  const repetido = await s.post('/admin/canais', { numero: 4, nome: 'Outro', url_hls: 'https://origem.test/outro.m3u8' }, admin);
  assert.equal(repetido.status, 409, 'número de canal não se repete');
});

test('grade: programa no ar agora, sem sobreposição, e guia do assinante', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 5, nome: 'PLAY News', categoria: 'noticias', url_hls: 'https://origem.test/news.m3u8' }, admin)).dados.canal;

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
  const canal = (await s.post('/admin/canais', { numero: 7, nome: 'Arena PLAY', categoria: 'esportes', url_hls: 'https://origem.test/arena.m3u8' }, admin)).dados.canal;

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
  const canal = (await s.post('/admin/canais', { numero: 11, nome: 'Cine PLAY', categoria: 'filmes', url_hls: 'https://origem.test/cine.m3u8', plano_minimo_id: 3 }, admin)).dados.canal;

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

test('importar a TV aberta deixa tudo cadastrado e desligado, sem duplicar', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const r = await s.post('/admin/canais/importar-abertos', {}, admin);
  assert.equal(r.status, 200);
  assert.ok(r.dados.criados >= 15, 'importa a lista inteira');
  assert.match(r.dados.proximo_passo, /cadastre o endereço do sinal/i);

  const { canais } = (await s.get('/admin/canais', admin)).dados;
  const globo = canais.find((c) => c.nome === 'TV Globo');
  assert.ok(globo, 'a Globo entra no cadastro');
  assert.equal(globo.ativo, false, 'entra desligada: só vai ao ar com o sinal cadastrado');
  assert.equal(globo.url_hls, null);
  assert.match(globo.observacao, /sinal/i, 'diz onde procurar o sinal');
  assert.ok(canais.some((c) => c.nome === 'SBT') && canais.some((c) => c.nome === 'Record')
    && canais.some((c) => c.nome === 'Band') && canais.some((c) => c.nome === 'RedeTV!'));

  // Nada disso aparece para o assinante enquanto estiver desligado.
  const cliente = await s.assinante('aberta@exemplo.com.br', { plano: 2 });
  assert.equal((await s.get('/tv/canais', cliente.token, cliente.comPerfil)).dados.canais.length, 0);

  const denovo = await s.post('/admin/canais/importar-abertos', {}, admin);
  assert.equal(denovo.dados.criados, 0);
  assert.ok(denovo.dados.ja_existiam >= 15, 'não duplica o que já está cadastrado');
});

test('canal não vai ao ar sem endereço, seja sinal ou player da emissora', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const semNada = await s.post('/admin/canais', { numero: 5, nome: 'Sem Sinal', ativo: true }, admin);
  assert.equal(semNada.status, 422);
  assert.match(semNada.dados.erro, /endereço do sinal/i);

  const semEmbed = await s.post('/admin/canais', { numero: 5, nome: 'Sem Player', fonte: 'embed', ativo: true }, admin);
  assert.equal(semEmbed.status, 422);
  assert.match(semEmbed.dados.erro, /player oficial/i);

  // Desligado, pode ficar cadastrado esperando o sinal.
  const guardado = await s.post('/admin/canais', { numero: 5, nome: 'Aguardando', ativo: false }, admin);
  assert.equal(guardado.status, 201);
  assert.equal(guardado.dados.canal.url_hls, null);
});

test('canal com player oficial da emissora abre o player dela, sem transmissão', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const criado = await s.post('/admin/canais', {
    numero: 48, nome: 'Canal de Notícias', categoria: 'noticias', fonte: 'embed',
    url_embed: 'https://www.youtube.com/watch?v=AbCdEf12345', ativo: true,
  }, admin);
  assert.equal(criado.status, 201, JSON.stringify(criado.dados));
  // O endereço colado vira o endereço de incorporação do player.
  assert.equal(criado.dados.canal.url_embed, 'https://www.youtube.com/embed/AbCdEf12345?autoplay=1&rel=0&modestbranding=1&playsinline=1');

  const cliente = await s.assinante('embed@exemplo.com.br', { plano: 2 });
  const abrir = await s.post('/play/abrir', { tipo: 'canal', canal_id: criado.dados.canal.id }, cliente.token, cliente.comPerfil);
  assert.equal(abrir.status, 201);
  assert.equal(abrir.dados.fonte.tipo, 'embed');
  assert.equal(abrir.dados.fonte.nossos_servidores, false, 'não passa pelo nosso servidor');
  assert.match(abrir.dados.fonte.url, /youtube\.com\/embed\//);

  // A página libera só a origem do player cadastrado.
  const pagina = await fetch(`${s.raiz}/`);
  const csp = pagina.headers.get('content-security-policy');
  assert.match(csp, /frame-src 'self' https:\/\/www\.youtube\.com/);
  assert.match(csp, /frame-ancestors 'none'/);

  const endereco = await s.post('/admin/canais', { numero: 49, nome: 'Endereço Ruim', fonte: 'embed', url_embed: 'http://sem-https.test/live', ativo: true }, admin);
  assert.equal(endereco.status, 422, 'player oficial precisa ser https');
});

test('canal cadastrado mas ainda sem sinal avisa ao assinante', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const canal = (await s.post('/admin/canais', { numero: 5, nome: 'TV Globo', ativo: false }, admin)).dados.canal;
  // A operação ligou o canal direto no banco antes de cadastrar o sinal (ou o sinal foi apagado).
  s.db.prepare('UPDATE canais SET ativo = 1 WHERE id = ?').run(canal.id);
  const cliente = await s.assinante('semsinal@exemplo.com.br', { plano: 2 });
  const r = await s.post('/play/abrir', { tipo: 'canal', canal_id: canal.id }, cliente.token, cliente.comPerfil);
  assert.equal(r.status, 409);
  assert.equal(r.dados.detalhes.motivo, 'sem_sinal');
});

test('importação de grade por endereço recusa rede interna', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const r = await s.post('/admin/epg/importar-url', { url: 'http://127.0.0.1:9/epg.xml' }, admin);
  assert.equal(r.status, 422);
  assert.match(r.dados.erro, /rede interna/i);
});

test('sinal que exige cabeçalho próprio guarda e reenvia o cabeçalho', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const { cabecalhosDoCanal } = require('../server/lib/relay');

  const canal = { cabecalhos: JSON.stringify({ user_agent: 'PlayerDaEmissora/2.0', referrer: 'https://emissora.test/' }) };
  assert.deepEqual(cabecalhosDoCanal(canal), { 'User-Agent': 'PlayerDaEmissora/2.0', Referer: 'https://emissora.test/' });
  assert.deepEqual(cabecalhosDoCanal({ cabecalhos: null }), {});
  assert.deepEqual(cabecalhosDoCanal({ cabecalhos: 'isto não é json' }), {});
});

test('canal importado de lista pública entra desligado e com o aviso para a operação', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  // Importa na mão o que a lista pública traria (sem depender da internet no teste).
  const criado = await s.post('/admin/canais', {
    numero: 200,
    nome: 'Canal Regional da Lista',
    categoria: 'local',
    url_hls: 'https://origem.test/regional/index.m3u8',
    observacao: 'Importado da lista pública (iptv-org) · sinal 720p. Teste o sinal e confirme que pode transmitir este canal antes de ligar.',
    ativo: false,
  }, admin);
  assert.equal(criado.status, 201);
  assert.equal(criado.dados.canal.ativo, 0);
  assert.match(criado.dados.canal.observacao, /antes de ligar/);

  // Enquanto desligado, não aparece para o assinante.
  const cliente = await s.assinante('lista@exemplo.com.br', { plano: 2 });
  assert.equal((await s.get('/tv/canais', cliente.token, cliente.comPerfil)).dados.canais.length, 0);
});

test('logo da emissora: o nome só casa quando é mesmo o canal', async () => {
  const { mesmoCanal, chaveDoNome } = require('../server/lib/listas-publicas');

  // A palavra genérica do começo não atrapalha.
  assert.equal(mesmoCanal('TV Globo', 'Globo'), true);
  assert.equal(mesmoCanal('RedeTV!', 'Rede TV!'), true);
  assert.equal(mesmoCanal('TV Cultura', 'tv cultura'), true);
  assert.equal(chaveDoNome('RedeTV!'), 'redetv');

  // Emissoras diferentes que só parecem iguais depois de cortar a palavra do começo.
  assert.equal(mesmoCanal('Rede Brasil', 'TV Brasil'), false);
  assert.equal(mesmoCanal('TV Gazeta', 'Rede Gazeta'), false);
  // Restos curtos demais não bastam para dizer que é o mesmo canal.
  assert.equal(mesmoCanal('TV Rio', 'Rede Rio'), false);
  assert.equal(mesmoCanal('', 'Globo'), false);
});

test('logo: host que bloqueia o servidor é abandonado, e os outros continuam', async (t) => {
  // Por que este teste existe: 79% dos logos de canais brasileiros da lista pública estão no
  // imgur, que bloqueia o ENDEREÇO do servidor depois de uma rajada de pedidos. Medido: a partir
  // daí ele responde 403 em 4 ms, para sempre naquela janela. Antes disto, o script insistia
  // canal por canal — 4 tentativas de 30s mais esperas, mais de dois minutos cada — e um
  // provedor com 116 canais ficava horas moendo para colher zero logo.
  const { melhorLogo, notaDoHost } = require('../server/lib/listas-publicas');

  // Entre logos iguais, o que não está num host que bloqueia ganha.
  const doImgur = { channel: 'X.br', url: 'https://i.imgur.com/a.png', width: 512, height: 512, in_use: true };
  const doWiki = { channel: 'X.br', url: 'https://upload.wikimedia.org/a.png', width: 512, height: 512, in_use: true };
  assert.equal(melhorLogo([doImgur, doWiki]).url, doWiki.url, 'com alternativa, não se escolhe o imgur');
  assert.equal(melhorLogo([doImgur]).url, doImgur.url, 'sem alternativa, o imgur ainda serve');
  assert.ok(notaDoHost('https://upload.wikimedia.org/a.png') > notaDoHost('https://i.imgur.com/a.png'));
  // Subdomínio não engana nem para o bem nem para o mal.
  assert.equal(notaDoHost('https://i.imgur.com.exemplo.test/a.png'), 0);
  assert.equal(notaDoHost('não é endereço'), -500);

  // E a regra de desistir do host: cinco recusas seguidas e ele sai da rodada.
  const logos = require('../server/lib/logos');
  const { iniciar } = require('./helpers');
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  for (let i = 1; i <= 9; i += 1) {
    const feito = await s.post('/admin/canais', { numero: 300 + i, nome: `Canal Bloqueado ${i}`, fonte: 'rtmp', url_hls: 'rtmp://origem.interna/live/x' }, admin);
    assert.equal(feito.status, 201, JSON.stringify(feito.dados));
  }

  const baixar = require('../server/lib/baixar');
  const originalBaixar = baixar.baixarImagem;
  const publicas = require('../server/lib/listas-publicas');
  const originalLogo = publicas.logoDoCanal;
  let pedidos = 0;
  publicas.logoDoCanal = async (nome) => ({ url: 'https://i.imgur.com/qualquer.png', nome });
  baixar.baixarImagem = async () => {
    pedidos += 1;
    const err = new Error('O endereço da imagem respondeu 403.');
    throw err;
  };
  t.after(() => { baixar.baixarImagem = originalBaixar; publicas.logoDoCanal = originalLogo; });

  const r = await logos.aplicarEmTodos(s.db, { pausaMs: 0 });
  assert.deepEqual(r.hosts_bloqueados, ['i.imgur.com'], 'o host que recusou cinco vezes é abandonado');
  assert.equal(pedidos, 5, 'depois da quinta recusa não se pede mais nada àquele host');
  assert.ok(r.pulados >= 4, `os canais seguintes são adiados, não tentados (foram ${r.pulados})`);
  assert.equal(r.com_logo.length, 0);
});
