'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const http = require('node:http');
const { iniciar } = require('./helpers');
const ip = require('../server/lib/ip');
const { decodificar, EstadoTemplates } = require('../server/lib/fluxos/decodificar');
const gerar = require('../server/lib/fluxos/gerar');
const { Agregador } = require('../server/lib/fluxos/agregador');
const { iniciarColetorRede } = require('../server/lib/fluxos/servico');
const mitigacao = require('../server/lib/mitigacao');
const radius = require('../server/lib/radius');
const avisos = require('../server/lib/avisos');
const { Pdf } = require('../server/lib/pdf');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
function enviarUdp(porta, pacote) {
  return new Promise((ok, falha) => {
    const s = dgram.createSocket('udp4');
    s.send(pacote, porta, '127.0.0.1', (err) => { s.close(); if (err) falha(err); else ok(); });
  });
}

test('endereços e prefixos', () => {
  assert.equal(ip.lerPrefixo('2001:DB8:0:0:1::/64').texto, '2001:db8::/64');
  assert.equal(ip.lerPrefixo('192.0.2.1/24', { estrito: true }), null, 'bits de host ligados');
  assert.equal(ip.lerPrefixo('192.0.2.1/24').texto, '192.0.2.0/24');
  assert.equal(ip.lerPrefixo('10.0.0.0/33'), null);
  assert.equal(ip.v6Texto(ip.lerIp('2001:db8:0:0:1:0:0:1').n), '2001:db8::1:0:0:1');
  assert.ok(ip.contemPrefixo(ip.lerPrefixo('100.64.0.0/10'), ip.lerPrefixo('100.127.255.0/24')));
  const t = new ip.TabelaPrefixos();
  t.adicionar('10.0.0.0/8', 'a');
  t.adicionar('10.1.0.0/16', 'b');
  t.adicionar('2001:db8::/32', 'c');
  const b = (x) => { const i = ip.lerIp(x); return t.buscar(i.v, i.n); };
  assert.deepEqual([b('10.1.2.3'), b('10.9.9.9'), b('11.0.0.1'), b('2001:db8:5::1'), b('2001:db9::1')], ['b', 'a', undefined, 'c', undefined]);
});

test('leitura de NetFlow v5, v9, IPFIX e sFlow (com amostragem, IPv6 e PPPoE)', () => {
  const fl = [{ src: '198.51.100.9', dst: '203.0.113.7', sport: 53, dport: 4444, proto: 17, bytes: 1500, pkts: 1 },
    { src: '2001:db8::1', dst: '2001:db8:1::9', sport: 1, dport: 443, proto: 6, bytes: 600, pkts: 10, flags: 2 }];
  const ctx = () => ({ exportador: '192.0.2.1', taxaPadrao: 1, estado: new EstadoTemplates() });
  const txt = (r) => r.fluxos.map((f) => `${ip.ipTexto(f.v, f.src)}>${ip.ipTexto(f.v, f.dst)} ${f.proto}/${f.sport}/${f.dport} ${f.bytes}B ${f.pkts}p f${f.flags}`);

  assert.deepEqual(txt(decodificar(gerar.netflow5(fl.slice(0, 1), { amostragem: 10 }), ctx())), ['198.51.100.9>203.0.113.7 17/53/4444 15000B 10p f0']);
  // v9: sem template os dados são descartados (contados); com template e opções de amostragem, multiplicados pela taxa
  const c9 = ctx();
  assert.equal(decodificar(gerar.netflow9(fl, { comTemplate: false }), c9).semTemplate, 2);
  assert.deepEqual(txt(decodificar(gerar.netflow9(fl, { amostragem: 100 }), c9)),
    ['198.51.100.9>203.0.113.7 17/53/4444 150000B 100p f0', '2001:db8::1>2001:db8:1::9 6/1/443 60000B 1000p f2']);
  assert.equal(decodificar(gerar.netflow9(fl, { comTemplate: false }), c9).fluxos[0].bytes, 150000, 'template e amostragem guardados por exportador');
  assert.deepEqual(txt(decodificar(gerar.netflow9(fl, { ipfix: true, amostragem: 10 }), ctx())),
    ['198.51.100.9>203.0.113.7 17/53/4444 15000B 10p f0', '2001:db8::1>2001:db8:1::9 6/1/443 6000B 100p f2']);
  assert.deepEqual(txt(decodificar(gerar.sflow(fl, { taxa: 512 }), ctx())),
    ['198.51.100.9>203.0.113.7 17/53/4444 768000B 512p f0', '2001:db8::1>2001:db8:1::9 6/1/443 32768B 512p f2']);
  assert.deepEqual(txt(decodificar(gerar.sflow(fl.slice(0, 1), { taxa: 2, pppoe: true }), ctx())), ['198.51.100.9>203.0.113.7 17/53/4444 3000B 2p f0'], 'PPPoE do BRAS');
  assert.throws(() => decodificar(Buffer.from([0, 77, 0, 0]), ctx()), /formato desconhecido/);
});

test('agregador: direção, janelas de 5/10/60 s e gravação por minuto e hora', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.login();
  const g = (await api.post('/ddos/grupos', { nome: 'Clientes', prefixos: ['203.0.113.0/24', '2001:db8:100::/48'] }, tk)).dados;
  assert.equal(g.nome, 'Clientes');
  const ag = new Agregador();
  ag.carregarGrupos(api.db);
  const org = api.db.prepare('SELECT organizacao_id FROM grupos_ip WHERE id = ?').get(g.id).organizacao_id;
  const exp = { org, papel: 'borda' };
  const f = (src, dst, bytes, extra = {}) => ({ ...ip.lerIp(src), src: ip.lerIp(src).n, dst: ip.lerIp(dst).n, v: ip.lerIp(src).v, sport: 53, dport: 1000, proto: 17, flags: 0, bytes, pkts: 1, ...extra });
  const T = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(ag.registrar(f('198.51.100.1', '203.0.113.10', 1000), exp, T), 'entrada');
  assert.equal(ag.registrar(f('203.0.113.10', '198.51.100.1', 500), exp, T), 'saida');
  assert.equal(ag.registrar(f('203.0.113.10', '203.0.113.11', 500), exp, T), null, 'interno não conta como entrada/saída na borda');
  assert.equal(ag.registrar(f('198.51.100.1', '198.51.100.2', 500), exp, T), null, 'trânsito');
  assert.equal(ag.registrar(f('198.51.100.1', '203.0.113.10', 1000), { org, papel: 'bras' }, T), null, 'BRAS não entra no Anti-DDoS de borda');
  ag.registrar(f('2001:db8:ffff::1', '2001:db8:100::5', 4000), exp, T + 3000);
  const c = ag.contadores.get(`${org}|entrada|4|${ip.lerIp('203.0.113.10').n}`);
  const fim = Math.floor(T / 1000);
  assert.equal(c.taxa('bps', 5, fim), (1000 * 8) / 5);
  assert.equal(c.taxa('bps', 60, fim), (1000 * 8) / 60);
  assert.equal(c.taxa('bps', 5, fim + 5), 0, 'fora da janela');
  assert.equal(c.taxa('udp_bps', 10, fim), 800);
  assert.ok(ag.gravar(api.db, T + 60_000) >= 3);
  const m = api.db.prepare('SELECT direcao, bytes FROM trafego_minuto ORDER BY direcao').all();
  assert.deepEqual(m.map((x) => [x.direcao, x.bytes]), [['entrada', 5000], ['saida', 500]]);
  const h = api.db.prepare("SELECT ip, bytes FROM trafego_ip_hora WHERE direcao = 'entrada' ORDER BY ip").all();
  assert.deepEqual(h.map((x) => [x.ip, x.bytes]), [['2001:db8:100::5', 4000], ['203.0.113.10', 1000]]);
});

test('Anti-DDoS: detecção pelo coletor UDP, mitigação, proteções, BGP, avisos e relatório', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  // Relógio do coletor 10 min no passado: o resumo ignora o intervalo ainda em andamento.
  let T = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
  // Canal Telegram falso (servidor local no lugar da API oficial)
  const recebidas = [];
  let falharTelegram = false;
  const tg = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (d) => { corpo += d; });
    req.on('end', () => {
      recebidas.push({ url: req.url, corpo: JSON.parse(corpo) });
      res.writeHead(falharTelegram ? 500 : 200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  }).listen(0);
  await new Promise((r) => tg.once('listening', r));
  t.after(() => tg.close());

  // Configuração
  assert.equal((await api.post('/ddos/grupos', { nome: 'X' }, tk.consulta)).status, 403, 'consulta não configura');
  const grupo = (await api.post('/ddos/grupos', { nome: 'Clientes residenciais', prefixos: ['203.0.113.0/24'], mitigacao_modo: 'automatica', mitigacao_tipo: 'flowspec' }, tk.noc)).dados;
  assert.equal((await api.post(`/ddos/grupos/${grupo.id}/prefixos`, { prefixo: '203.0.113.5/24' }, tk.noc)).status, 422, 'bits de host');
  assert.equal((await api.post(`/ddos/grupos/${grupo.id}/prefixos`, { prefixo: '203.0.113.0/24' }, tk.noc)).status, 409, 'repetido');
  const lim = (await api.post(`/ddos/grupos/${grupo.id}/limites`, { escopo: 'ip', direcao: 'entrada', metrica: 'bps', limite: 100e6, janela_s: 5, severidade: 'alta' }, tk.noc)).dados;
  assert.equal(lim.limite, 100e6);
  assert.equal((await api.post(`/ddos/grupos/${grupo.id}/limites-sugeridos`, {}, tk.noc)).dados.criados, 7, 'sugeridos sem repetir o bps de entrada');
  const cfg = (await api.get('/ddos/config', tk.noc)).dados;
  assert.equal((await api.put('/ddos/config', { versao: cfg.versao, encerrar_apos_s: 10, confirmacoes: 2, max_acoes_simultaneas: 2 }, tk.noc)).status, 200);
  assert.equal((await api.post('/ddos/nunca-bloquear', { prefixo: '203.0.113.53', motivo: 'DNS recursivo' }, tk.noc)).status, 201);
  assert.equal((await api.post('/trafego/exportadores', { nome: 'Borda 01', ip: '127.0.0.1', papel: 'borda', taxa_amostragem: 1 }, tk.noc)).status, 201);
  const canal = (await api.post('/avisos/canais', { tipo: 'telegram', nome: 'NOC Telegram', segredo: '123:ABC', config: { chats: '-1001234', url_api: `http://127.0.0.1:${tg.address().port}` } }, tk.admin)).dados;
  assert.equal(canal.credencial_configurada, true);
  assert.equal(JSON.stringify(canal).includes('123:ABC'), false, 'token do bot nunca volta');
  assert.equal((await api.post('/avisos/canais', { tipo: 'telegram', nome: 'x', segredo: '1', config: { chats: '1' } }, tk.noc)).status, 403, 'só admin configura avisos');

  const coletor = iniciarColetorRede(api.db, { host: '127.0.0.1', portasFluxo: [0], portaRadius: 0, lacos: false, relogio: () => T });
  t.after(() => coletor.fechar());
  const portas = await coletor.pronto;
  const ataqueDns = (dst, bytes = 80e6) => gerar.netflow9([
    { src: '198.51.100.20', dst, sport: 53, dport: 41000, proto: 17, bytes: Math.round(bytes * 0.7), pkts: 50_000 },
    { src: '198.51.100.21', dst, sport: 53, dport: 41001, proto: 17, bytes: Math.round(bytes * 0.3), pkts: 20_000 },
  ]);

  await t.test('pacote de IP não cadastrado é ignorado', async () => {
    const outro = iniciarColetorRede(api.db, { host: '127.0.0.1', portasFluxo: [0], lacos: false, relogio: () => T });
    const p = await outro.pronto;
    api.db.prepare("UPDATE exportadores_fluxo SET ativo = 0").run();
    outro.recarregar();
    await enviarUdp(p.fluxo[0], ataqueDns('203.0.113.10'));
    await esperar(80);
    assert.equal(outro.desconhecidos.fluxo.get('127.0.0.1'), 1);
    assert.equal(outro.agregador.contadores.size, 0);
    outro.fechar();
    api.db.prepare("UPDATE exportadores_fluxo SET ativo = 1").run();
  });

  let ataque;
  await t.test('confirmação em 2 avaliações abre o ataque com o vetor e o bloqueio automático', async () => {
    await enviarUdp(portas.fluxo[0], ataqueDns('203.0.113.10'));
    await esperar(80);
    T += 1000;
    let r = coletor.avaliar();
    assert.deepEqual(r.abertos, [], 'primeira avaliação acima do limite só liga a captura');
    await enviarUdp(portas.fluxo[0], ataqueDns('203.0.113.10'));
    await esperar(80);
    T += 1000;
    r = coletor.avaliar();
    assert.equal(r.abertos.length, 1);
    ataque = (await api.get(`/ddos/ataques/${r.abertos[0]}`, tk.noc)).dados;
    assert.equal(ataque.direcao, 'entrada');
    assert.equal(ataque.alvo, '203.0.113.10');
    assert.equal(ataque.vetor, 'Amplificação DNS (UDP 53)');
    assert.equal(ataque.metrica, 'bps');
    assert.equal(ataque.origens[0].chave, '198.51.100.20');
    assert.equal(ataque.mitigacoes.length, 1);
    const m = ataque.mitigacoes[0];
    assert.equal(m.status, 'ativa');
    assert.equal(m.origem, 'automatica');
    assert.deepEqual(m.regra, { destino: '203.0.113.10/32', protocolo: 17, porta_origem: 53, acao: 'descartar' });
    assert.equal(m.comandos.anunciar, 'announce flow route { match { destination 203.0.113.10/32; protocol =17; source-port =53; } then { discard; } }');
  });

  await t.test('ExaBGP lê os anúncios ativos pelo token com escopo bgp', async () => {
    const semEscopo = (await api.post('/noc/coletores', { nome: 'Agente' }, tk.admin)).dados;
    assert.equal((await api.req('GET', '/coletor/bgp', undefined, semEscopo.token)).status, 403);
    assert.equal((await api.post('/noc/coletores', { nome: 'x', escopos: ['root'] }, tk.admin)).status, 422);
    const bgp = (await api.post('/noc/coletores', { nome: 'ExaBGP', escopos: ['bgp'] }, tk.admin)).dados;
    const r = (await api.req('GET', '/coletor/bgp', undefined, bgp.token)).dados;
    assert.equal(r.anuncios.length, 1);
    assert.match(r.anuncios[0].anunciar, /^announce flow route/);
    assert.match(r.anuncios[0].retirar, /^withdraw flow route/);
  });

  await t.test('lista "nunca bloquear" impede o bloqueio automático', async () => {
    await enviarUdp(portas.fluxo[0], ataqueDns('203.0.113.53'));
    await esperar(80);
    T += 1000; coletor.avaliar();
    await enviarUdp(portas.fluxo[0], ataqueDns('203.0.113.53'));
    await esperar(80);
    T += 1000;
    const r = coletor.avaliar();
    assert.equal(r.abertos.length, 1);
    const a = (await api.get(`/ddos/ataques/${r.abertos[0]}`, tk.noc)).dados;
    assert.equal(a.mitigacoes[0].status, 'bloqueada');
    assert.match(a.mitigacoes[0].motivo, /nunca bloquear/);
    // Pedido manual também é barrado
    const man = (await api.post('/ddos/mitigacoes', { tipo: 'blackhole', alvo: '203.0.113.53', motivo: 'teste' }, tk.noc)).dados;
    assert.equal(man.status, 'bloqueada');
  });

  await t.test('limite de ações simultâneas, aprovação manual e permissões', async () => {
    api.db.prepare("UPDATE grupos_ip SET mitigacao_modo = 'manual', mitigacao_tipo = 'blackhole'").run();
    coletor.recarregar();
    for (const alvo of ['203.0.113.20', '203.0.113.21']) {
      await enviarUdp(portas.fluxo[0], ataqueDns(alvo));
      await esperar(60);
    }
    T += 1000; coletor.avaliar();
    for (const alvo of ['203.0.113.20', '203.0.113.21']) {
      await enviarUdp(portas.fluxo[0], ataqueDns(alvo));
      await esperar(60);
    }
    T += 1000;
    assert.equal(coletor.avaliar().abertos.length, 2);
    const pend = (await api.get('/ddos/mitigacoes?status=aguardando_aprovacao', tk.noc)).dados.itens;
    assert.equal(pend.length, 2);
    assert.equal(pend[0].comandos.anunciar.startsWith(`announce route ${pend[0].prefixo} next-hop 192.0.2.1 community [65535:666]`), true);
    assert.equal((await api.post(`/ddos/mitigacoes/${pend[0].id}/aprovar`, {}, tk.consulta)).status, 403);
    assert.equal((await api.post(`/ddos/mitigacoes/${pend[0].id}/aprovar`, {}, tk.gestor)).status, 403, 'gestor só vê');
    const ap = await api.post(`/ddos/mitigacoes/${pend[0].id}/aprovar`, {}, tk.noc);
    assert.equal(ap.dados.status, 'ativa');
    assert.equal(ap.dados.aprovada_por, tk.noc_id);
    // Já há 2 ativas (flowspec do .10 e blackhole aprovado): a segunda aprovação passa do limite.
    const neg = await api.post(`/ddos/mitigacoes/${pend[1].id}/aprovar`, {}, tk.noc);
    assert.equal(neg.status, 409);
    assert.match(neg.dados.erro, /Limite de 2 ações simultâneas/);
    assert.equal((await api.post(`/ddos/mitigacoes/${pend[1].id}/recusar`, { motivo: 'Cliente corporativo, tratar com ele' }, tk.noc)).dados.status, 'recusada');
    assert.equal((await api.post('/ddos/mitigacoes', { tipo: 'blackhole', alvo: '203.0.113.0/24', motivo: 'x' }, tk.noc)).status, 422, 'blackhole de bloco');
  });

  await t.test('retirada automática no prazo e retirada ao entrar na lista "nunca bloquear"', async () => {
    const ativas = api.db.prepare("SELECT * FROM mitigacoes WHERE status = 'ativa' ORDER BY id").all();
    assert.equal(ativas.length, 2);
    api.db.prepare('UPDATE mitigacoes SET expira_em = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), ativas[0].id);
    assert.equal(mitigacao.expirar(api.db), 1);
    const x = api.db.prepare('SELECT * FROM mitigacoes WHERE id = ?').get(ativas[0].id);
    assert.equal(x.status, 'retirada');
    assert.match(x.motivo_retirada, /automática/);
    const r = (await api.post('/ddos/nunca-bloquear', { prefixo: ativas[1].prefixo, motivo: 'Servidor do cliente' }, tk.noc)).dados;
    assert.deepEqual(r.acoes_retiradas, [ativas[1].id]);
    const aud = api.db.prepare("SELECT COUNT(*) AS n FROM auditoria WHERE acao IN ('mitigacao_aprovada','mitigacao_retirada','mitigacao_recusada')").get().n;
    assert.ok(aud >= 4, 'quem fez cada ação fica no log');
  });

  await t.test('ataque encerra pela histerese e o histórico guarda o fim', async () => {
    T += 30_000; // sem tráfego: abaixo de 80% do limite por mais de 10 s
    coletor.avaliar();
    T += 11_000;
    const r = coletor.avaliar();
    assert.ok(r.encerrados.includes(ataque.id));
    const a = (await api.get(`/ddos/ataques/${ataque.id}`, tk.consulta)).dados;
    assert.equal(a.status, 'encerrado');
    assert.ok(a.fim);
    assert.ok(a.eventos.some((e) => e.tipo === 'fim'));
    assert.equal(a.assinante, null, 'consulta não vê login');
  });

  await t.test('avisos no Telegram com novas tentativas', async () => {
    assert.ok(await avisos.processar(api.db) >= 3);
    assert.ok(recebidas.length >= 3);
    assert.equal(recebidas[0].url, '/bot123:ABC/sendMessage');
    assert.equal(recebidas[0].corpo.chat_id, '-1001234');
    assert.match(recebidas[0].corpo.text, /^Manager Network Alertas\n/);
    assert.ok(recebidas.some((x) => /Ataque detectado #1/.test(x.corpo.text) && /Amplificação DNS/.test(x.corpo.text)));
    falharTelegram = true;
    avisos.enfileirar(api.db, 1, 'ataque_inicio', { texto: 'teste de falha', severidade: 'critica' });
    await avisos.processar(api.db);
    const e = api.db.prepare('SELECT * FROM avisos_envios ORDER BY id DESC LIMIT 1').get();
    assert.equal(e.status, 'pendente');
    assert.equal(e.tentativas, 1);
    assert.match(e.erro, /HTTP 500/);
    assert.equal((await api.post(`/avisos/canais/${canal.id}/testar`, {}, tk.admin)).dados.ok, false);
    falharTelegram = false;
    assert.equal((await api.post(`/avisos/canais/${canal.id}/testar`, {}, tk.admin)).dados.ok, true);
  });

  await t.test('relatório do ataque em PDF', async () => {
    const r = await fetch(`${api.raiz}/api/ddos/ataques/${ataque.id}/pdf`, { headers: { Authorization: `Bearer ${tk.noc}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.subarray(0, 5).toString(), '%PDF-');
    assert.match(b.toString('latin1'), /Relat\xf3rio de ataque #1/);
    assert.match(b.toString('latin1'), /%%EOF\n$/);
  });

  await t.test('tráfego gravado: resumo, top IPs e ficha do IP', async () => {
    coletor.gravar();
    const r = (await api.get('/trafego/resumo?horas=24', tk.consulta)).dados;
    assert.ok(r.serie.length >= 1);
    assert.ok(r.totais.entrada.bytes >= 80e6 * 2);
    const top = (await api.get('/trafego/top?direcao=entrada&horas=24', tk.consulta)).dados;
    assert.equal(top.itens[0].ip.startsWith('203.0.113.'), true);
    assert.equal(top.itens[0].login, undefined, 'consulta não vê login');
    const csv = await api.get('/trafego/top?direcao=entrada&horas=24&formato=csv', tk.noc);
    assert.match(csv.dados, /IP;Grupo;Login;Bytes/);
    const ficha = (await api.get('/trafego/ip/203.0.113.10', tk.noc)).dados;
    assert.equal(ficha.ataques.length, 1);
    assert.ok(Array.isArray(ficha.sessoes));
  });

  await t.test('isolamento entre organizações', async () => {
    const outro = await api.outraOrganizacao();
    assert.equal((await api.get(`/ddos/ataques/${ataque.id}`, outro)).status, 404);
    assert.equal((await api.get('/ddos/mitigacoes?status=todas', outro)).dados.total, 0);
    assert.equal((await api.post('/trafego/exportadores', { nome: 'Roubo', ip: '127.0.0.1' }, outro)).status, 409, 'IP de exportador é único no sistema');
  });
});

test('RADIUS: accounting por UDP com resposta assinada, sessões, API e privacidade', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const SEGREDO = 'segredo-radius-123';
  assert.equal((await api.post('/trafego/nas', { nome: 'BRAS Centro', ip: '127.0.0.1', segredo: SEGREDO }, tk.noc)).status, 201);
  const fontes = (await api.get('/trafego/fontes', tk.noc)).dados;
  assert.equal(JSON.stringify(fontes).includes(SEGREDO), false);
  const coletor = iniciarColetorRede(api.db, { host: '127.0.0.1', portasFluxo: [], portaRadius: 0, lacos: false });
  t.after(() => coletor.fechar());
  const { radius: porta } = await coletor.pronto;
  const A = radius.ATR;

  const trocar = (pacote) => new Promise((ok) => {
    const s = dgram.createSocket('udp4');
    const timer = setTimeout(() => { s.close(); ok(null); }, 300);
    s.on('message', (m) => { clearTimeout(timer); s.close(); ok(m); });
    s.send(pacote, porta, '127.0.0.1');
  });

  const inicio = radius.montarPedido({ id: 7, atributos: [[A.STATUS_TYPE, 1], [A.USER_NAME, 'joao.silva'], [A.SESSION_ID, 'S-001'], [A.FRAMED_IP, '100.64.10.20'],
    [A.NAS_IP, '10.0.0.1'], [A.CALLING_STATION, 'AA:BB:CC:00:11:22'], [A.DELEGATED_IPV6_PREFIX, '2001:db8:200:1000::/56']] }, SEGREDO);
  const resp = await trocar(inicio);
  assert.ok(resp, 'Accounting-Response recebido');
  assert.equal(resp[0], 5);
  assert.equal(resp[1], 7);
  const esperado = require('node:crypto').createHash('md5').update(Buffer.concat([resp.subarray(0, 4), inicio.subarray(4, 20)])).update(SEGREDO).digest();
  assert.deepEqual(resp.subarray(4, 20), esperado, 'autenticador da resposta');
  assert.equal(await trocar(radius.montarPedido({ id: 8, atributos: [[A.STATUS_TYPE, 1], [A.USER_NAME, 'x'], [A.SESSION_ID, 'S-9']] }, 'segredo-errado')), null,
    'segredo errado: sem resposta');
  const fim = radius.montarPedido({ id: 9, atributos: [[A.STATUS_TYPE, 2], [A.USER_NAME, 'joao.silva'], [A.SESSION_ID, 'S-001'], [A.FRAMED_IP, '100.64.10.20'],
    [A.NAS_IP, '10.0.0.1'], [A.INPUT_OCTETS, 1000], [A.OUTPUT_OCTETS, 5000], [A.OUTPUT_GIGA, 1], [A.TERMINATE_CAUSE, 1]] }, SEGREDO);
  assert.ok(await trocar(fim));
  coletor.gravarEstatisticas();
  const s = api.db.prepare('SELECT * FROM sessoes_assinantes').all();
  assert.equal(s.length, 1);
  assert.equal(s[0].login, 'joao.silva');
  assert.equal(s[0].ipv6_delegado, '2001:db8:200:1000::/56');
  assert.equal(s[0].bytes_entrada, 5000 + 2 ** 32);
  assert.equal(s[0].motivo_fim, 'Pedido do usuário');
  assert.ok(s[0].fim);
  const nas = api.db.prepare('SELECT pacotes, erros, ultimo_erro FROM radius_nas').get();
  assert.equal(nas.pacotes, 3);
  assert.equal(nas.erros, 1);
  assert.match(nas.ultimo_erro, /autenticador inválido/);

  // API de sessões (alternativa ao UDP)
  const semEscopo = (await api.post('/noc/coletores', { nome: 'Agente' }, tk.admin)).dados;
  assert.equal((await api.post('/coletor/sessoes', { tipo: 'inicio' }, null, { Authorization: `Bearer ${semEscopo.token}` })).status, 403);
  const tok = (await api.post('/noc/coletores', { nome: 'FreeRADIUS', escopos: ['sessoes'] }, tk.admin)).dados;
  const r = (await api.post('/coletor/sessoes', { eventos: [
    { tipo: 'inicio', login: 'maria', sessao_id: 'X1', nas_ip: '10.0.0.2', ip: '100.64.10.20', em: '2026-11-10T10:00:00Z' },
    { tipo: 'inicio', login: 'pedro', sessao_id: 'X2', nas_ip: '10.0.0.2', ip: '100.64.10.20', em: '2026-11-10T11:00:00Z' },
    { tipo: 'inicio', login: 'z', sessao_id: 'X3', nas_ip: 'nao-e-ip' },
  ] }, null, { Authorization: `Bearer ${tok.token}` })).dados;
  assert.deepEqual(r.resultado.map((x) => x.acao), ['criada', 'criada', 'invalido']);
  const maria = api.db.prepare("SELECT * FROM sessoes_assinantes WHERE login = 'maria'").get();
  assert.equal(maria.fim, '2026-11-10T11:00:00.000Z', 'IP entregue a outra sessão fecha a anterior');
  assert.equal(radius.loginNoInstante(api.db, 1, '100.64.10.20', '2026-11-10T10:30:00.000Z').login, 'maria');
  assert.equal(radius.loginNoInstante(api.db, 1, '100.64.10.20', '2026-11-10T11:30:00.000Z').login, 'pedro');
  // Busca e permissões
  assert.equal((await api.get('/trafego/sessoes?busca=maria', tk.noc)).dados.total, 1);
  assert.equal((await api.get('/trafego/sessoes?busca=100.64.10.20', tk.noc)).dados.total, 3);
  assert.equal((await api.get('/trafego/sessoes?busca=maria', tk.consulta)).status, 403, 'consulta/TV não vê dados de assinantes');
});

test('PDF: acentos em WinAnsi e estrutura válida', () => {
  const b = new Pdf().texto(40, 40, 'Relatório de ação — ç ã é (teste)').novaPagina().texto(40, 40, 'Página 2').gerar();
  const s = b.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.match(s, /Relat\xf3rio de a\xe7\xe3o \x97 \xe7 \xe3 \xe9 \\\(teste\\\)/);
  assert.match(s, /\/Count 2/);
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(xref, xref + 4), 'xref');
});
