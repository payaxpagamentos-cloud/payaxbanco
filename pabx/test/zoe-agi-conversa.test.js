'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { criarAgi, criarApiCerebro, conversar, escolherModo, atendeu, fimDaLigacao, ramalDoCanal } = require('../scripts/zoe-agi');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-agi-falas-'));
// Um WAV com cara de fala de verdade: cabeçalho + 1 s de áudio 8 kHz.
const WAV_FALA = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(16000, 1)]);

/**
 * Asterisk de mentira. `falas`: o que acontece em cada RECORD FILE —
 *   'audio'      → grava um WAV de fala;
 *   'silencio'   → grava quase nada;
 *   { tecla, resto } → o cliente aperta uma tecla (e o GET DATA seguinte lê o resto).
 */
function asterisk(falas, { desligarNoRecord = Infinity, teclas = [], canal = {} } = {}) {
  const deAsterisk = new PassThrough();
  const paraAsterisk = new PassThrough();
  const comandos = [];
  const variaveis = {};
  const faladas = [];
  const gravados = [];
  let gravacoes = 0;
  let restoPendente = null;
  let buffer = '';
  paraAsterisk.setEncoding('utf8');
  paraAsterisk.on('data', (p) => {
    buffer += p;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const cmd = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      comandos.push(cmd);
      const sv = cmd.match(/^SET VARIABLE (\w+) "(.*)"$/);
      if (sv) variaveis[sv[1]] = sv[2];
      const ex = cmd.match(/^EXEC \w+ "(.*)"$/);
      if (ex) faladas.push(ex[1]);
      const rec = cmd.match(/^RECORD FILE (\S+) wav/);
      if (rec) {
        gravacoes++;
        if (gravacoes > desligarNoRecord) { deAsterisk.write('200 result=-1\n'); continue; }
        const f = falas.shift() ?? 'silencio';
        const arquivo = `${rec[1]}.wav`;
        gravados.push(arquivo);
        if (typeof f === 'object') {
          restoPendente = f.resto ?? '';
          deAsterisk.write(`200 result=${f.tecla.charCodeAt(0)} (dtmf) endpos=800\n`);
          continue;
        }
        fs.writeFileSync(arquivo, f === 'audio' ? WAV_FALA : Buffer.from('RIFF....WAVE'));
        deAsterisk.write('200 result=0 (silence) endpos=8000\n');
        continue;
      }
      const gv = cmd.match(/^GET VARIABLE (\w+)$/);
      if (gv) {
        const val = variaveis[gv[1]] ?? variaveis[`__${gv[1]}`] ?? canal[gv[1]];
        deAsterisk.write(val ? `200 result=1 (${val})\n` : '200 result=0\n');
        continue;
      }
      if (cmd.startsWith('GET DATA')) {
        const r = restoPendente ?? teclas.shift() ?? '';
        restoPendente = null;
        deAsterisk.write(`200 result=${r}\n`);
        continue;
      }
      deAsterisk.write('200 result=0\n');
    }
  });
  return { agi: criarAgi(deAsterisk, paraAsterisk), comandos, variaveis, faladas, gravados };
}

/** O ZOE Atende de mentira: responde cada turno com o próximo passo do roteiro. */
async function cerebroFalso(roteiro, { quebrarNoInicio = false, inicio = null } = {}) {
  const pedidos = [];
  const s = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const dados = corpo ? JSON.parse(corpo) : {};
      pedidos.push({ url: req.url, chave: req.headers['x-api-key'], dados });
      if (quebrarNoInicio) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"erro":"fora"}'); return; }
      let resposta = { ok: true };
      if (req.url.endsWith('/voz/ligacoes')) resposta = inicio ?? { acao: 'ouvir', fala: 'Olá! Sou a ZOE. Como posso ajudar?' };
      else if (req.url.endsWith('/turno')) resposta = roteiro.shift() ?? { acao: 'encerrar', fala: 'Até mais!' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(resposta));
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, pedidos, fechar: () => new Promise((r) => s.close(r)) };
}

const ENV = { agi_uniqueid: '1700000099.7', agi_callerid: '11988887777' };

test('conversa: ouve, manda a fala para o cérebro e transfere para a fila que ele escolheu', async (t) => {
  const zoe = await cerebroFalso([
    { acao: 'ouvir', fala: 'Entendi. Para sua segurança, me diga os três primeiros números do CPF.' },
    { acao: 'transferir', fala: 'Vou te passar para o suporte.', fila: { id: 3, nome: 'Suporte' }, resumo: 'Internet caindo; já reiniciou o roteador.',
      sussurro: 'Ligação da ZOE: Ana Souza, identidade confirmada. Assunto: internet caindo.' },
  ]);
  t.after(() => zoe.fechar());
  const a = asterisk(['audio', { tecla: '1', resto: '23' }]);

  const status = await conversar(a.agi, criarApiCerebro(zoe.url, 'atd_teste'), ENV, { tts: 'Flite', gravacoes: pasta });

  assert.equal(status, 'transferir');
  assert.equal(a.variaveis.ZOE_STATUS, 'transferir');
  assert.equal(a.variaveis.ZOE_FILA_NOME, 'Suporte', 'o plano de discagem continua o mesmo: Queue(${ZOE_FILA_NOME})');
  assert.equal(a.variaveis.ZOE_RESUMO, 'Internet caindo; já reiniciou o roteador.');
  assert.deepEqual(a.faladas, [
    'Olá! Sou a ZOE. Como posso ajudar?',
    'Entendi. Para sua segurança, me diga os três primeiros números do CPF.',
    'Vou te passar para o suporte.',
  ]);

  assert.equal(a.variaveis.__ZOE_UID, ENV.agi_uniqueid, 'herdável: o canal do ramal sabe de qual ligação se trata');
  assert.match(a.variaveis.__ZOE_SUSSURRO, /Ana Souza/);

  const [inicio, turno1, turno2, ...resto] = zoe.pedidos;
  assert.equal(inicio.chave, 'atd_teste');
  assert.deepEqual(inicio.dados, { uid: ENV.agi_uniqueid, telefone: ENV.agi_callerid });
  assert.equal(Buffer.from(turno1.dados.audio_base64, 'base64').length, WAV_FALA.length, 'a fala gravada vai inteira para ser transcrita lá');
  assert.equal(turno2.dados.digitos, '123', 'apertou 1 e digitou 23: o CPF vai pelo teclado');
  assert.equal(resto.length, 0, 'transferida, a ligação continua com uma pessoa: quem fecha a conversa é o "h"');
  assert.ok(a.gravados.every((f) => !fs.existsSync(f)), 'nenhuma gravação de cliente fica no disco');
});

test('atendeu: o ramal que pegou a ligação avisa o painel e ouve o sussurro antes do cliente', async (t) => {
  const zoe = await cerebroFalso([]);
  t.after(() => zoe.fechar());
  const a = asterisk([], { canal: { ZOE_UID: '1700000099.7', ZOE_SUSSURRO: 'Ligação da ZOE: Ana Souza, identidade confirmada.' } });

  const r = await atendeu(a.agi, { agi_channel: 'PJSIP/201-0000002a' }, criarApiCerebro(zoe.url, 'atd_teste'), { tts: 'Flite' });
  assert.equal(r, 'avisado');
  assert.equal(zoe.pedidos.length, 1);
  assert.match(zoe.pedidos[0].url, /\/voz\/ligacoes\/1700000099\.7\/atendida$/);
  assert.deepEqual(zoe.pedidos[0].dados, { ramal: '201' });
  assert.deepEqual(a.faladas, ['Ligação da ZOE: Ana Souza, identidade confirmada.']);
});

test('atendeu: ligação que não passou pela ZOE não chama nada', async (t) => {
  const zoe = await cerebroFalso([]);
  t.after(() => zoe.fechar());
  const a = asterisk([]);
  assert.equal(await atendeu(a.agi, { agi_channel: 'PJSIP/202-01' }, criarApiCerebro(zoe.url, 'k'), { tts: 'Flite' }), 'sem-zoe');
  assert.equal(zoe.pedidos.length, 0);
  assert.deepEqual(a.faladas, []);
});

test('atendeu: ZOE Atende fora do ar não segura o atendente — o sussurro sai mesmo assim', async (t) => {
  const zoe = await cerebroFalso([], { quebrarNoInicio: true });
  t.after(() => zoe.fechar());
  const a = asterisk([], { canal: { ZOE_UID: 'x1', ZOE_SUSSURRO: 'Ligação da ZOE.' } });
  assert.equal(await atendeu(a.agi, { agi_channel: 'SIP/203-9' }, criarApiCerebro(zoe.url, 'k'), { tts: 'Flite' }), 'avisado');
  assert.deepEqual(a.faladas, ['Ligação da ZOE.']);
});

test('fim: o "h" do plano de discagem fecha a conversa pela ligação certa', async (t) => {
  const zoe = await cerebroFalso([]);
  t.after(() => zoe.fechar());
  const a = asterisk([], { canal: { ZOE_UID: '1700000099.7' } });
  await fimDaLigacao(a.agi, { agi_uniqueid: 'outro' }, criarApiCerebro(zoe.url, 'k'));
  assert.match(zoe.pedidos[0].url, /1700000099\.7\/fim$/);
});

test('ramal do canal: PJSIP, SIP e Local', () => {
  assert.equal(ramalDoCanal('PJSIP/201-0000002a'), '201');
  assert.equal(ramalDoCanal('SIP/3005-00ab'), '3005');
  assert.equal(ramalDoCanal('Local/202@from-queue-00000001;2'), '202');
  assert.equal(ramalDoCanal('DAHDI/1-1'), '');
});

test('por teclas: lê quantas teclas a ZOE pediu, em vez de gravar fala', async (t) => {
  const zoe = await cerebroFalso([
    { acao: 'ouvir', fala: 'Digite os três primeiros números do CPF.', aguardar: 'digitos', max_digitos: 3 },
    { acao: 'transferir', fala: 'Vou te passar para o financeiro.', fila: { id: 2, nome: 'Financeiro' }, resumo: 'Segunda via.' },
  ], { inicio: { acao: 'ouvir', fala: 'Digite 1 para segunda via ou 0 para atendente.', aguardar: 'digitos', max_digitos: 1 } });
  t.after(() => zoe.fechar());
  const a = asterisk([], { teclas: ['1', '123'] });

  const status = await conversar(a.agi, criarApiCerebro(zoe.url, 'k'), ENV, { tts: 'Flite', gravacoes: pasta });

  assert.equal(status, 'transferir');
  assert.equal(a.variaveis.ZOE_FILA_NOME, 'Financeiro');
  const leituras = a.comandos.filter((c) => c.startsWith('GET DATA'));
  assert.deepEqual(leituras, ['GET DATA silence/1 6000 1', 'GET DATA silence/1 10000 3'],
    'uma tecla no menu (sem esperar à toa); três para o começo do CPF');
  assert.equal(a.comandos.filter((c) => c.startsWith('RECORD FILE')).length, 0, 'no modo teclas nada é gravado');
  assert.deepEqual(zoe.pedidos.slice(1, 3).map((p) => p.dados.digitos), ['1', '123']);
});

test('silêncio vai como fala vazia: quem decide repetir ou transferir é o cérebro', async (t) => {
  const zoe = await cerebroFalso([{ acao: 'encerrar', fala: 'Obrigada por ligar!' }]);
  t.after(() => zoe.fechar());
  const a = asterisk(['silencio']);
  const status = await conversar(a.agi, criarApiCerebro(zoe.url, 'k'), ENV, { tts: 'Flite', gravacoes: pasta });
  assert.equal(status, 'resolvido');
  assert.deepEqual(zoe.pedidos[1].dados, { texto: '', turno_id: '1' });
});

test('desligou no meio: avisa o cérebro e para', async (t) => {
  const zoe = await cerebroFalso([{ acao: 'ouvir', fala: 'Pode falar.' }]);
  t.after(() => zoe.fechar());
  const a = asterisk(['audio'], { desligarNoRecord: 1 });
  const status = await conversar(a.agi, criarApiCerebro(zoe.url, 'k'), ENV, { tts: 'Flite', gravacoes: pasta });
  assert.equal(status, 'desligou');
  assert.match(zoe.pedidos.at(-1).url, /\/fim$/, 'a ligação é encerrada no histórico do cliente');
});

test('cérebro fora do ar no início: a mesma ligação segue pela URA de teclas', async (t) => {
  const zoe = await cerebroFalso([], { quebrarNoInicio: true });
  t.after(() => zoe.fechar());
  const a = asterisk([]);
  let usouTeclas = false;
  const teclas = { iniciar: async () => { usouTeclas = true; throw new Error('sem pabx neste teste'); } };
  await escolherModo(a.agi, ENV, { cerebro: criarApiCerebro(zoe.url, 'k'), teclas, tts: 'Flite', gravacoes: pasta });
  assert.equal(usouTeclas, true, 'caiu para a reserva em vez de deixar a pessoa no silêncio');
});

test('sem TTS não dá para falar texto livre: fica na URA de teclas', async (t) => {
  const zoe = await cerebroFalso([]);
  t.after(() => zoe.fechar());
  const a = asterisk([]);
  let usouTeclas = false;
  const teclas = { iniciar: async () => { usouTeclas = true; throw new Error('x'); } };
  await escolherModo(a.agi, ENV, { cerebro: criarApiCerebro(zoe.url, 'k'), teclas, tts: '' });
  assert.equal(usouTeclas, true);
  assert.equal(zoe.pedidos.length, 0);
});

test('nada configurado: indisponível, e o plano de discagem manda para a fila', async () => {
  const a = asterisk([]);
  const status = await escolherModo(a.agi, ENV, {});
  assert.equal(status, 'indisponivel');
  assert.equal(a.variaveis.ZOE_STATUS, 'indisponivel');
});

test.after(() => fs.rmSync(pasta, { recursive: true, force: true }));
