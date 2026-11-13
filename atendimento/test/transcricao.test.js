'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const h = require('./helpers');
const config = require('../server/config');
const transcricao = require('../server/lib/transcricao');

// ffmpeg é o que converte o OGG do WhatsApp. Sem ele na máquina de teste, os testes que
// dependem de áudio de verdade são pulados — os de decisão e de texto continuam rodando.
const temFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const comAudio = temFfmpeg ? test : test.skip;

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-transcricao-'));
/** Um áudio de WhatsApp de verdade: OGG/Opus, mono, com a duração pedida. */
function audioOgg(segundos, nome = `a${segundos}`) {
  const arquivo = path.join(pasta, `${nome}.ogg`);
  if (!fs.existsSync(arquivo)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`,
      '-c:a', 'libopus', '-b:a', '16k', '-ar', '16000', '-ac', '1', arquivo]);
  }
  return arquivo;
}

/** Um whisper-server de mentira: responde o texto pedido e conta quantos atende ao mesmo tempo. */
function fingirWhisper({ texto = 'minha internet caiu', status = 200, demoraMs = 0 } = {}) {
  const estado = { pedidos: 0, simultaneos: 0, maxSimultaneos: 0, corpos: [] };
  const s = http.createServer((req, res) => {
    estado.pedidos++;
    estado.simultaneos++;
    estado.maxSimultaneos = Math.max(estado.maxSimultaneos, estado.simultaneos);
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      estado.corpos.push(Buffer.concat(partes).toString('latin1'));
      setTimeout(() => {
        estado.simultaneos--;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: typeof texto === 'function' ? texto() : texto }));
      }, demoraMs);
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${s.address().port}`, estado, fechar: () => new Promise((f) => s.close(f)),
  })));
}

const base = () => ({ ...config.transcricao });

describe('em que modo a transcrição roda', () => {
  test('sem nada instalado, fica desligada — e não finge que está ligada', () => {
    assert.equal(transcricao.modo({ ...base(), modo: 'auto', url: null, bin: null, modelo: null }), 'desligada');
  });
  test('com o endereço do whisper-server, usa o servidor', () => {
    assert.equal(transcricao.modo({ ...base(), modo: 'auto', url: 'http://127.0.0.1:8178' }), 'servidor');
  });
  test('local só liga se o programa e o modelo existem de verdade no disco', () => {
    assert.equal(transcricao.modo({ ...base(), modo: 'auto', url: null, bin: '/nao/existe', modelo: '/nao/existe' }), 'desligada');
  });
  test('desligada pela configuração vence tudo', () => {
    assert.equal(transcricao.modo({ ...base(), modo: 'desligada', url: 'http://127.0.0.1:8178' }), 'desligada');
  });
  test('a situação explica para a tela, sem caminho de arquivo nem endereço interno', () => {
    const s = transcricao.situacao({ ...base(), modo: 'auto', url: 'http://10.0.0.5:8178' });
    assert.equal(s.ligada, true);
    assert.doesNotMatch(JSON.stringify(s), /10\.0\.0\.5|8178/);
    assert.match(s.custo, /Nenhum por áudio/);
  });
});

describe('limpeza do texto', () => {
  test('tira as marcas de silêncio e música e junta as linhas', () => {
    assert.equal(transcricao.limpar(' [BLANK_AUDIO]\n Minha internet\n caiu.  [Música] '), 'Minha internet caiu.');
  });
  test('só silêncio vira vazio', () => {
    assert.equal(transcricao.limpar('[BLANK_AUDIO]'), '');
  });
});

describe('transcrever', () => {
  let whisper;
  afterEach(async () => { await whisper?.fechar(); whisper = null; });

  comAudio('pelo servidor: devolve o texto e o tempo que levou', async () => {
    whisper = await fingirWhisper({ texto: ' Bom dia, quero a segunda via do boleto. ' });
    const r = await transcricao.transcrever(audioOgg(2), { cfg: { ...base(), modo: 'servidor', url: whisper.url } });
    assert.equal(r.status, 'pronta');
    assert.equal(r.texto, 'Bom dia, quero a segunda via do boleto.');
    assert.ok(r.ms >= 0);
    // O áudio chega ao whisper já convertido para WAV, e pedindo português.
    assert.match(whisper.estado.corpos[0], /RIFF.*WAVE/s);
    assert.match(whisper.estado.corpos[0], /name="language"\r\n\r\npt/);
    // O vocabulário do provedor vai junto: puxa "atendente", "boleto", "roteador".
    assert.match(whisper.estado.corpos[0], /name="prompt"\r\n\r\nAtendimento de provedor de internet/);
  });

  comAudio('áudio longo demais não é transcrito', async () => {
    whisper = await fingirWhisper();
    const r = await transcricao.transcrever(audioOgg(4, 'longo'), { cfg: { ...base(), modo: 'servidor', url: whisper.url, maxSegundos: 3 } });
    assert.equal(r.status, 'longa');
    assert.equal(whisper.estado.pedidos, 0, 'nem chegou a mandar para o whisper');
  });

  comAudio('whisper fora do ar: falha sem derrubar quem chamou', async () => {
    const r = await transcricao.transcrever(audioOgg(1, 'curto'), { cfg: { ...base(), modo: 'servidor', url: 'http://127.0.0.1:1', timeoutMs: 2000 } });
    assert.equal(r.status, 'falhou');
    assert.ok(r.erro);
  });

  comAudio('whisper respondendo erro também é falha, não exceção', async () => {
    whisper = await fingirWhisper({ status: 500 });
    const r = await transcricao.transcrever(audioOgg(1, 'curto'), { cfg: { ...base(), modo: 'servidor', url: whisper.url } });
    assert.equal(r.status, 'falhou');
  });

  comAudio('áudio só com ruído vira falha, e não uma mensagem vazia', async () => {
    whisper = await fingirWhisper({ texto: '[BLANK_AUDIO]' });
    const r = await transcricao.transcrever(audioOgg(1, 'curto'), { cfg: { ...base(), modo: 'servidor', url: whisper.url } });
    assert.equal(r.status, 'falhou');
    assert.equal(r.erro, 'nada audível');
  });

  comAudio('uma rajada de áudios é atendida um por vez', async () => {
    whisper = await fingirWhisper({ demoraMs: 150 });
    const cfg = { ...base(), modo: 'servidor', url: whisper.url, simultaneos: 1 };
    const rs = await Promise.all([1, 2, 3, 4].map(() => transcricao.transcrever(audioOgg(1, 'curto'), { cfg })));
    assert.ok(rs.every((r) => r.status === 'pronta'));
    assert.equal(whisper.estado.maxSimultaneos, 1, 'uma rajada não pode travar a máquina inteira');
  });

  comAudio('pelo programa local: chama o whisper-cli com o modelo e o idioma', async () => {
    // Um "whisper-cli" de mentira que confere os argumentos e imprime o texto.
    const bin = path.join(pasta, 'whisper-cli-falso.sh');
    fs.writeFileSync(bin, '#!/bin/sh\ncase "$*" in *"-l pt"*"-m "*|*"-m "*"-l pt"*) echo " Quero falar com um atendente." ;; *) echo "argumentos errados: $*" >&2; exit 2 ;; esac\n');
    fs.chmodSync(bin, 0o755);
    const modelo = path.join(pasta, 'modelo.bin');
    fs.writeFileSync(modelo, 'x');
    const r = await transcricao.transcrever(audioOgg(1, 'curto'), { cfg: { ...base(), modo: 'local', url: null, bin, modelo } });
    assert.equal(r.status, 'pronta', r.erro);
    assert.equal(r.texto, 'Quero falar com um atendente.');
  });

  test('desligada: responde na hora, sem tentar nada', async () => {
    const r = await transcricao.transcrever('/qualquer.ogg', { cfg: { ...base(), modo: 'desligada' } });
    assert.equal(r.status, 'desligada');
  });
});

describe('o áudio na conversa', () => {
  let whisper;
  let meta;
  let ambiente;
  const original = { ...config.transcricao };

  beforeEach(() => { ambiente = h.criarAmbiente(); });
  afterEach(async () => {
    Object.assign(config.transcricao, original);
    meta?.restaurar();
    await whisper?.fechar();
    whisper = null;
  });

  /** Entrega um áudio do cliente pelo webhook, como a Meta entrega. */
  const mandarAudio = (db) => h.entregar(db, h.corpoWebhook({ type: 'audio', audio: { id: '1048576001', mime_type: 'audio/ogg; codecs=opus', voice: true } }));

  comAudio('a ZOE recebe o que o cliente FALOU, marcado como transcrição', async () => {
    const { db } = ambiente;
    meta = h.fingirMeta({ midia: { buffer: fs.readFileSync(audioOgg(2)), mime: 'audio/ogg' } });
    whisper = await fingirWhisper({ texto: 'Minha internet está caindo toda hora desde ontem.' });
    Object.assign(config.transcricao, { modo: 'servidor', url: whisper.url });

    const claude = h.fingirClaude([{ texto: 'Poxa, vou verificar a sua conexão agora.' }]);
    try {
      await mandarAudio(db);
      await require('../server/lib/envio').processarFila(db);
    } finally { claude.restaurar(); }

    const m = db.prepare("SELECT * FROM mensagens WHERE tipo = 'audio' ORDER BY id DESC LIMIT 1").get();
    assert.equal(m.transcricao_status, 'pronta');
    assert.equal(m.transcricao, 'Minha internet está caindo toda hora desde ontem.');
    assert.equal(m.texto, null, 'a coluna texto continua vazia: fica registrado que veio falado');

    const enviado = JSON.stringify(claude.pedidos[0].messages);
    assert.match(enviado, /transcrito automaticamente — pode ter erros/);
    assert.match(enviado, /Minha internet está caindo toda hora/);
    assert.doesNotMatch(enviado, /não foi possível transcrever/);
  });

  comAudio('pedir atendente em voz alta vale igual a pedir por escrito', async () => {
    const { db } = ambiente;
    meta = h.fingirMeta({ midia: { buffer: fs.readFileSync(audioOgg(2)), mime: 'audio/ogg' } });
    whisper = await fingirWhisper({ texto: 'Quero falar com um atendente, por favor.' });
    Object.assign(config.transcricao, { modo: 'servidor', url: whisper.url });

    const sem = h.semIa();
    try { await mandarAudio(db); } finally { sem.restaurar(); }
    const conversa = db.prepare('SELECT * FROM conversas ORDER BY id DESC LIMIT 1').get();
    // Igual ao texto: sem dizer o assunto, a ZOE pergunta o assunto uma vez antes de transferir.
    assert.equal(conversa.estado, 'bot');
    const evento = db.prepare("SELECT * FROM ia_eventos WHERE conversa_id = ? AND nome LIKE 'pedido de humano%'").get(conversa.id);
    assert.ok(evento, 'a regra de pedido de humano reconheceu a frase dita em voz alta');
  });

  test('transcrição desligada: a ZOE sabe que há um áudio que ela não ouviu', async () => {
    const { db } = ambiente;
    meta = h.fingirMeta({ midia: { buffer: Buffer.from('ogg'), mime: 'audio/ogg' } });
    Object.assign(config.transcricao, { modo: 'desligada' });

    const claude = h.fingirClaude([{ texto: 'Não consegui ouvir o seu áudio. Pode escrever, por favor?' }]);
    try {
      await mandarAudio(db);
    } finally { claude.restaurar(); }

    const m = db.prepare("SELECT * FROM mensagens WHERE tipo = 'audio' ORDER BY id DESC LIMIT 1").get();
    assert.equal(m.transcricao_status, 'desligada');
    assert.match(JSON.stringify(claude.pedidos[0].messages), /áudio que não foi possível transcrever — peça com gentileza para escrever/);
  });

  comAudio('o atendente vê a transcrição no detalhe da conversa', async () => {
    const { db, empresa } = ambiente;
    meta = h.fingirMeta({ midia: { buffer: fs.readFileSync(audioOgg(2)), mime: 'audio/ogg' } });
    whisper = await fingirWhisper({ texto: 'Preciso da segunda via.' });
    Object.assign(config.transcricao, { modo: 'servidor', url: whisper.url });
    const sem = h.semIa();
    try { await mandarAudio(db); } finally { sem.restaurar(); }

    const conversa = db.prepare('SELECT * FROM conversas ORDER BY id DESC LIMIT 1').get();
    const d = require('../server/lib/conversas').detalhe(db, empresa.id, conversa.id);
    const audio = d.mensagens.find((m) => m.tipo === 'audio');
    assert.equal(audio.transcricao, 'Preciso da segunda via.');
    assert.equal(audio.transcricao_status, 'pronta');
  });
});

after(() => fs.rmSync(pasta, { recursive: true, force: true }));
