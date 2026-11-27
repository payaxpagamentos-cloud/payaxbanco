'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { iniciar } = require('./helpers');

/** Monta um .tar.gz com a cara do pacote da plataforma (o que importa é ter server/index.js). */
function pacoteDeMentira(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-pacote-'));
  fs.mkdirSync(path.join(base, 'server'), { recursive: true });
  // Conteúdo aleatório: texto repetido comprime tanto que o .tar.gz sairia menor que o mínimo
  // aceito, e o teste falharia por tamanho em vez de testar o que interessa.
  fs.writeFileSync(path.join(base, 'server', 'index.js'), crypto.randomBytes(80 * 1024).toString('base64'));
  fs.writeFileSync(path.join(base, 'versao.json'), '{"versao":"9999.01.01"}');
  // O arquivo de saída fica FORA da pasta que o tar está lendo, senão ele reclama que o
  // conteúdo mudou durante a leitura.
  const saida = `${base}.tar.gz`;
  execFileSync('tar', ['-C', base, '-czf', saida, '.']);
  t.after(() => fs.rmSync(saida, { force: true }));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return fs.readFileSync(saida);
}

/** Pasta compartilhada do agente, trocada por uma temporária durante o teste. */
function pastaDeTeste(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-atualizacao-'));
  const antes = process.env.TV_ATUALIZACAO;
  process.env.TV_ATUALIZACAO = p;
  t.after(() => {
    fs.rmSync(p, { recursive: true, force: true });
    if (antes === undefined) delete process.env.TV_ATUALIZACAO; else process.env.TV_ATUALIZACAO = antes;
  });
  return p;
}

test('o painel mostra a versão instalada e o estado da atualização', async (t) => {
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const r = await s.get('/admin/sistema', admin);
  assert.equal(r.status, 200);
  assert.ok(r.dados.versao.versao, 'a versão vem do versao.json do pacote');
  assert.equal(r.dados.agente, true, 'a pasta compartilhada existe, então o agente está no lugar');
  assert.equal(r.dados.na_fila, null);
  assert.ok(fs.existsSync(pasta));

  // Curador não mexe no sistema; assinante muito menos.
  const curador = await s.assinante('curioso@exemplo.com.br');
  assert.equal((await s.get('/admin/sistema', curador.token)).status, 403);
});

test('o pacote enviado fica na pasta do agente, com o pedido marcado', async (t) => {
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const pacote = pacoteDeMentira(t);
  const r = await s.req('POST', '/admin/sistema/pacote', pacote, admin, { headers: { 'Content-Type': 'application/gzip' } });
  assert.equal(r.status, 202, JSON.stringify(r.dados));
  assert.equal(r.dados.pedido.bytes, pacote.length);

  assert.ok(fs.existsSync(path.join(pasta, 'pacote.tar.gz')), 'o pacote foi gravado para o agente pegar');
  const pedido = JSON.parse(fs.readFileSync(path.join(pasta, 'pedido.json'), 'utf8'));
  assert.equal(pedido.por, 'admin@playtechvip.com.br', 'fica registrado quem pediu');
  assert.equal(pedido.sha256.length, 64);

  const estado = await s.get('/admin/sistema', admin);
  assert.ok(estado.dados.na_fila, 'o painel passa a mostrar que há um pacote esperando');
});

test('arquivo que não é um pacote é recusado antes de chegar ao agente', async (t) => {
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  // Um PDF, uma foto, o arquivo errado do celular: nada disso pode virar pedido de atualização.
  const naoEhGzip = Buffer.alloc(4096, 0x41);
  const r = await s.req('POST', '/admin/sistema/pacote', naoEhGzip, admin, { headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 400);
  assert.match(r.dados.erro, /\.tar\.gz/i);
  assert.equal(fs.existsSync(path.join(pasta, 'pedido.json')), false, 'nada foi pedido ao agente');

  const vazio = Buffer.alloc(10);
  assert.equal((await s.req('POST', '/admin/sistema/pacote', vazio, admin, { headers: { 'Content-Type': 'application/gzip' } })).status, 400);
});

test('o pacote é conferido no envio, e o erro diz o que veio dentro', async (t) => {
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const enviar = (b) => s.req('POST', '/admin/sistema/pacote', b, admin, { headers: { 'Content-Type': 'application/gzip' } });

  // Um .tar.gz de verdade, mas de outra coisa: o painel precisa dizer isso na hora, e não
  // deixar o agente descobrir depois.
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-outro-'));
  // Grande o bastante para passar da guarda de tamanho: o que se testa aqui é o CONTEÚDO.
  fs.writeFileSync(path.join(fora, 'leia.txt'), crypto.randomBytes(80 * 1024).toString('base64'));
  const outro = path.join(fora, 'outro.tar.gz');
  execFileSync('tar', ['-C', fora, '-czf', outro, 'leia.txt']);
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }));

  const r = await enviar(fs.readFileSync(outro));
  assert.equal(r.status, 400);
  assert.match(r.dados.erro, /não é o pacote da plataforma/);
  assert.match(r.dados.erro, /leia\.txt/, 'a mensagem mostra o que havia dentro');
  assert.equal(fs.existsSync(path.join(pasta, 'pedido.json')), false, 'nada chega ao agente');

  // Gzip de conteúdo qualquer: não é nem tar.
  const lixo = await enviar(zlib.gzipSync(crypto.randomBytes(70 * 1024)));
  assert.equal(lixo.status, 400);
  assert.match(lixo.dados.erro, /corrompido|não é um \.tar\.gz/i);
});

test('o painel aceita o pacote em .zip, do mesmo jeito', async (t) => {
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-zip-'));
  fs.mkdirSync(path.join(base, 'server'), { recursive: true });
  fs.writeFileSync(path.join(base, 'server', 'index.js'), crypto.randomBytes(80 * 1024).toString('base64'));
  const zip = `${base}.zip`;
  execFileSync('zip', ['-qr', zip, '.'], { cwd: base });
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(zip, { force: true }); });

  const r = await s.req('POST', '/admin/sistema/pacote', fs.readFileSync(zip), admin, { headers: { 'Content-Type': 'application/zip' } });
  assert.equal(r.status, 202, JSON.stringify(r.dados));
  assert.equal(r.dados.pedido.formato, 'zip');
  assert.ok(fs.existsSync(path.join(pasta, 'pacote.zip')), 'fica para o agente com a extensão certa');
  assert.equal(fs.existsSync(path.join(pasta, 'pacote.tar.gz')), false, 'não sobra pacote do formato anterior');
});

test('o pacote chega do iPhone já descompactado, e ainda assim é aceito', async (t) => {
  // Por que este teste existe: o Safari do iPhone descompacta `.tar.gz` sozinho ao baixar. Quem
  // envia do celular acaba mandando um `.tar` — o pacote CERTO, só que já aberto uma camada — e
  // o painel recusava. Aceitar e recompactar aqui é melhor que pedir à operação que resolva um
  // detalhe do navegador.
  const pasta = pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();

  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-iphone-'));
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fora, 'server'), { recursive: true });
  fs.writeFileSync(path.join(fora, 'server', 'index.js'), crypto.randomBytes(60 * 1024).toString('base64'));
  const tar = path.join(fora, 'pacote.tar');
  execFileSync('tar', ['-C', fora, '-cf', tar, 'server']);

  // Content-Type que o aparelho resolveu inventar: não pode mais decidir nada.
  const r = await s.req('POST', '/admin/sistema/pacote', fs.readFileSync(tar), admin,
    { headers: { 'Content-Type': 'application/x-tar' } });
  assert.equal(r.status, 202, JSON.stringify(r.dados));

  // O agente só conhece pacote.tar.gz e pacote.zip: um pacote.tar ficaria esquecido na pasta
  // para sempre, e a operação veria "enviado" sem nada acontecer.
  assert.equal(r.dados.pedido.formato, 'tar.gz');
  assert.equal(fs.existsSync(path.join(pasta, 'pacote.tar.gz')), true, 'o agente precisa achar o pacote');
  assert.equal(fs.existsSync(path.join(pasta, 'pacote.tar')), false);
  // E o que ficou gravado é um .tar.gz de verdade, com o conteúdo certo dentro.
  const nomes = execFileSync('tar', ['-tzf', path.join(pasta, 'pacote.tar.gz')], { encoding: 'utf8' });
  assert.match(nomes, /server\/index\.js/);
});

test('arquivo recusado explica o que chegou, em vez de só dizer que não serve', async (t) => {
  // A mensagem antiga virava "Este arquivo não é o pacote da plataforma." e ponto, sempre que
  // não desse para ler nome nenhum lá dentro. Quem estava no celular não tinha como saber se
  // mandou o arquivo errado ou se a plataforma é que estava recusando o certo.
  pastaDeTeste(t);
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const enviar = (b, tipo = 'application/octet-stream') =>
    s.req('POST', '/admin/sistema/pacote', b, admin, { headers: { 'Content-Type': tipo } });

  // Nem gzip, nem zip, nem tar: um arquivo qualquer.
  const qualquer = await enviar(Buffer.alloc(50 * 1024, 0x41));
  assert.equal(qualquer.status, 400);
  assert.match(qualquer.dados.erro, /não é um \.tar\.gz, um \.tar nem um \.zip/);
  assert.match(qualquer.dados.erro, /0\.05 MB/, 'diz quanto chegou');
  assert.match(qualquer.dados.erro, /PLAYTECHVIP-servidor\.tar\.gz/, 'diz qual é o arquivo certo');

  // Um tar legítimo, mas de outra coisa: a mensagem mostra o que havia dentro.
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-outro2-'));
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fora, 'fotos'), { recursive: true });
  fs.writeFileSync(path.join(fora, 'fotos', 'a.txt'), crypto.randomBytes(60 * 1024).toString('base64'));
  execFileSync('tar', ['-C', fora, '-czf', path.join(fora, 'x.tar.gz'), 'fotos']);
  const outro = await enviar(fs.readFileSync(path.join(fora, 'x.tar.gz')));
  assert.equal(outro.status, 400);
  assert.match(outro.dados.erro, /dentro dele há: fotos/);
  assert.match(outro.dados.erro, /MB/, 'o tamanho entra na mensagem');
});
