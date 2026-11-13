'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const config = require('../config');

/**
 * Áudio do cliente vira texto, na própria máquina, com o whisper.cpp.
 *
 * Cliente de provedor manda áudio o tempo todo. Sem isto, a ZOE só enxerga "[o cliente enviou
 * um áudio]" e tem de pedir para a pessoa escrever — justo quem mandou áudio porque não quer
 * escrever. Com isto, o áudio entra na conversa como se tivesse sido digitado.
 *
 * Não custa nada por áudio: o modelo roda aqui. Medido nesta máquina (4 núcleos, modelo small):
 *   - modo servidor (whisper-server com o modelo carregado): ~2,6 a 3,6 s por áudio de 7 a 13 s;
 *   - modo local (whisper-cli, recarrega o modelo a cada áudio): ~4,5 a 5 s.
 *
 * Três regras:
 *   1. Nunca derrubar a conversa. Se a transcrição falhar, demorar ou estiver desligada, a ZOE
 *      responde do mesmo jeito, pedindo com educação para a pessoa escrever.
 *   2. Um áudio por vez (configurável). Uma rajada de 30 áudios não pode travar a máquina
 *      inteira — cada um espera a sua vez.
 *   3. Áudio longo demais não é transcrito: três minutos de áudio levam tempo, e a ZOE pede um
 *      resumo por escrito em vez de deixar o cliente esperando.
 */

const exec = (bin, args, { timeout }) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const e = new Error(err.killed ? 'tempo esgotado' : String(stderr || err.message).trim().split('\n').pop()?.slice(0, 200) || 'falhou');
      e.codigo = err.code;
      return reject(e);
    }
    return resolve(String(stdout));
  });
});

/** Em que modo a transcrição está rodando, decidido pela configuração e pelo que existe no disco. */
function modo(cfg = config.transcricao) {
  if (cfg.modo === 'desligada') return 'desligada';
  if (cfg.modo === 'servidor' || (cfg.modo === 'auto' && cfg.url)) return cfg.url ? 'servidor' : 'desligada';
  if (cfg.modo === 'local' || cfg.modo === 'auto') {
    return cfg.bin && cfg.modelo && fs.existsSync(cfg.bin) && fs.existsSync(cfg.modelo) ? 'local' : 'desligada';
  }
  return 'desligada';
}

/** O que a tela mostra: está ligada? de que jeito? Sem caminho de arquivo nem endereço interno. */
function situacao(cfg = config.transcricao) {
  const m = modo(cfg);
  return {
    modo: m,
    ligada: m !== 'desligada',
    descricao: {
      servidor: 'Ligada: whisper.cpp no próprio servidor, com o modelo sempre carregado.',
      local: 'Ligada: whisper.cpp no próprio servidor, carregando o modelo a cada áudio.',
      desligada: cfg.modo === 'desligada'
        ? 'Desligada pela configuração do servidor.'
        : 'Desligada: o whisper.cpp não está instalado neste servidor. A ZOE pede para o cliente escrever.',
    }[m],
    max_segundos: cfg.maxSegundos,
    custo: 'Nenhum por áudio: roda na própria máquina.',
  };
}

// ---------- Fila: um áudio por vez (ou N) ----------
let emAndamento = 0;
const esperando = [];
async function naVez(fn, limite) {
  if (emAndamento >= limite) await new Promise((r) => esperando.push(r));
  emAndamento++;
  try { return await fn(); } finally {
    emAndamento--;
    esperando.shift()?.();
  }
}

/** Duração do áudio em segundos, pelo ffprobe. Sem ffprobe, devolve null e segue. */
async function duracao(arquivo, cfg) {
  try {
    const s = await exec(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', arquivo], { timeout: 10_000 });
    const n = Number(s.trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** OGG/Opus do WhatsApp para WAV 16 kHz mono, que é o que o whisper espera. */
async function paraWav(arquivo, cfg) {
  const saida = path.join(os.tmpdir(), `zoe-audio-${crypto.randomBytes(6).toString('hex')}.wav`);
  await exec(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', arquivo, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', saida], { timeout: 30_000 });
  return saida;
}

async function viaServidor(wav, cfg) {
  const corpo = new FormData();
  corpo.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'audio.wav');
  corpo.append('response_format', 'json');
  corpo.append('language', cfg.idioma);
  corpo.append('temperature', '0.0');
  if (cfg.prompt) corpo.append('prompt', cfg.prompt);
  const r = await fetch(`${cfg.url}/inference`, { method: 'POST', body: corpo, signal: AbortSignal.timeout(cfg.timeoutMs) });
  if (!r.ok) throw new Error(`o servidor do whisper respondeu ${r.status}`);
  const d = await r.json();
  return String(d.text ?? '');
}

async function viaLocal(wav, cfg) {
  const args = ['-m', cfg.modelo, '-f', wav, '-l', cfg.idioma, '-t', String(cfg.threads), '-nt', '-np'];
  if (cfg.prompt) args.push('--prompt', cfg.prompt);
  const out = await exec(cfg.bin, args, { timeout: cfg.timeoutMs });
  return out;
}

/** Limpa o que o whisper devolve: espaços, quebras e as marcações de silêncio e música. */
const limpar = (t) => String(t ?? '')
  .replace(/\[(BLANK_AUDIO|MUSIC|MÚSICA|SILÊNCIO|silence|music)[^\]]*\]/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Transcreve um arquivo de áudio. Devolve { status, texto, ms, segundos }.
 *   status: 'pronta' | 'longa' | 'falhou' | 'desligada'
 * Nunca lança erro: quem chama decide o que fazer com cada status.
 */
async function transcrever(arquivo, { cfg = config.transcricao } = {}) {
  const m = modo(cfg);
  if (m === 'desligada') return { status: 'desligada', texto: null, ms: 0 };
  if (!arquivo || !fs.existsSync(arquivo)) return { status: 'falhou', texto: null, ms: 0, erro: 'arquivo não encontrado' };

  const segundos = await duracao(arquivo, cfg);
  if (segundos !== null && segundos > cfg.maxSegundos) return { status: 'longa', texto: null, ms: 0, segundos };

  return naVez(async () => {
    const ini = Date.now();
    let wav = null;
    try {
      wav = await paraWav(arquivo, cfg);
      const bruto = m === 'servidor' ? await viaServidor(wav, cfg) : await viaLocal(wav, cfg);
      const texto = limpar(bruto);
      // Áudio só com silêncio ou ruído: não há o que dizer à ZOE além de "não deu para entender".
      if (!texto) return { status: 'falhou', texto: null, ms: Date.now() - ini, segundos, erro: 'nada audível' };
      return { status: 'pronta', texto, ms: Date.now() - ini, segundos };
    } catch (err) {
      return { status: 'falhou', texto: null, ms: Date.now() - ini, segundos, erro: err.message };
    } finally {
      if (wav) fs.rm(wav, { force: true }, () => {});
    }
  }, Math.max(1, cfg.simultaneos));
}

module.exports = { transcrever, modo, situacao, limpar };
