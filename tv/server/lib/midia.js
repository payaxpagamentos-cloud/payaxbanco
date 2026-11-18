'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const qualidades = require('./qualidades');

/**
 * Formatos aceitos, reconhecidos pelo conteúdo do arquivo (assinatura dos primeiros bytes),
 * não pelo nome nem pelo cabeçalho enviado pelo navegador.
 */
function detectarVideo(b) {
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const marca = b.subarray(8, 12).toString('latin1');
    // MP4/MOV e variantes (isom, mp42, avc1, M4V, qt). O player toca MP4 direto e por HLS.
    if (/^(isom|iso2|iso4|iso5|iso6|mp41|mp42|avc1|dash|M4V |M4VP|mmp4|qt  )$/.test(marca)) {
      return { mime: marca === 'qt  ' ? 'video/quicktime' : 'video/mp4', ext: marca === 'qt  ' ? 'mov' : 'mp4' };
    }
    return { mime: 'video/mp4', ext: 'mp4' };
  }
  // Matroska / WebM
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const cabeca = b.subarray(0, Math.min(b.length, 1024)).toString('latin1');
    return cabeca.includes('webm') ? { mime: 'video/webm', ext: 'webm' } : { mime: 'video/x-matroska', ext: 'mkv' };
  }
  // Fluxo de transporte MPEG (.ts) — pacotes de 188 bytes começando com 0x47.
  if (b.length >= 189 && b[0] === 0x47 && b[188] === 0x47) return { mime: 'video/mp2t', ext: 'ts' };
  return null;
}

function detectarImagem(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '<svg ') return { mime: 'image/svg+xml', ext: 'svg' };
  return null;
}

const caminho = (m) => path.join(config.midiaDir, m.arquivo);
const nomeLimpo = (n, padrao) => String(n ?? padrao).replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 160) || padrao;

/** Qualidade pela altura da imagem do vídeo. */
const qualidadePorAltura = (altura, largura = 0) => qualidades.porMedidas(largura, altura);

/** Caminho relativo novo (ano/mês/aleatório.ext), com a pasta criada. */
function novoArquivo(ext) {
  const d = new Date();
  const relativo = path.join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), `${crypto.randomBytes(20).toString('hex')}.${ext}`);
  fs.mkdirSync(path.dirname(path.join(config.midiaDir, relativo)), { recursive: true });
  return relativo;
}

/**
 * Abre o envio de um vídeo em pedaços (o navegador fatia o arquivo e manda um pedaço por requisição).
 * O arquivo nasce vazio e cresce a cada parte; só vira 'pronta' quando o tamanho combinado chega.
 */
function abrirEnvioVideo(db, usuario, { nome, tamanho, duracao_s: duracao, largura, altura }) {
  const bytes = v.inteiro(tamanho, 'o tamanho do arquivo', { min: 1, max: config.videoMaxBytes });
  const relativo = novoArquivo('bin');
  fs.writeFileSync(path.join(config.midiaDir, relativo), Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  const r = db.prepare(`INSERT INTO midias (tipo, arquivo, nome_original, mime, tamanho, recebido, duracao_s, largura, altura, qualidade, status, enviado_por, criado_em)
    VALUES ('video', ?, ?, 'application/octet-stream', ?, 0, ?, ?, ?, ?, 'enviando', ?, ?)`)
    .run(relativo, nomeLimpo(nome, 'video.mp4'), bytes, v.inteiroOpcional(duracao, 'a duração', { min: 0, max: 86_400 }),
      v.inteiroOpcional(largura, 'a largura', { min: 0, max: 16_384 }), v.inteiroOpcional(altura, 'a altura', { min: 0, max: 16_384 }),
      qualidadePorAltura(Number(altura) || 0, Number(largura) || 0), usuario.id, agora());
  return db.prepare('SELECT * FROM midias WHERE id = ?').get(Number(r.lastInsertRowid));
}

/** Grava uma parte do vídeo na posição informada (permite repetir a última parte se a rede caiu). */
function receberParte(db, id, offset, conteudo) {
  const m = buscar(db, id);
  if (m.tipo !== 'video') throw new ErroNegocio('Este envio não é de vídeo.', 409);
  if (m.status !== 'enviando') throw new ErroNegocio('Este envio já foi concluído.', 409);
  if (!Buffer.isBuffer(conteudo) || !conteudo.length) throw new ErroNegocio('Parte vazia.', 422);
  const pos = v.inteiro(offset, 'a posição da parte', { min: 0, max: m.tamanho });
  if (pos > m.recebido) throw new ErroNegocio(`Parte fora de ordem: o servidor recebeu ${m.recebido} byte(s).`, 409, { recebido: m.recebido });
  if (pos + conteudo.length > m.tamanho) throw new ErroNegocio('A parte passa do tamanho informado no início do envio.', 413);
  const fd = fs.openSync(caminho(m), 'r+');
  try {
    fs.writeSync(fd, conteudo, 0, conteudo.length, pos);
  } finally {
    fs.closeSync(fd);
  }
  const recebido = Math.max(m.recebido, pos + conteudo.length);
  db.prepare('UPDATE midias SET recebido = ? WHERE id = ?').run(recebido, m.id);
  return { id: m.id, recebido, tamanho: m.tamanho, concluido: recebido >= m.tamanho };
}

/** Fecha o envio: confere o tamanho, reconhece o formato pelo conteúdo e calcula o SHA-256. */
function concluirEnvioVideo(db, id, { duracao_s: duracao, largura, altura } = {}) {
  const m = buscar(db, id);
  if (m.status === 'pronta') return m;
  const arquivo = caminho(m);
  const real = fs.statSync(arquivo).size;
  if (real !== m.tamanho) throw new ErroNegocio(`Envio incompleto: ${real} de ${m.tamanho} byte(s).`, 409, { recebido: real, tamanho: m.tamanho });
  const fd = fs.openSync(arquivo, 'r');
  const cabeca = Buffer.alloc(Math.min(4096, real));
  try {
    fs.readSync(fd, cabeca, 0, cabeca.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const tipo = detectarVideo(cabeca);
  if (!tipo) {
    db.prepare("UPDATE midias SET status = 'erro' WHERE id = ?").run(m.id);
    throw new ErroNegocio('Formato de vídeo não reconhecido. Envie MP4 (H.264/AAC), WebM ou MKV.', 415);
  }
  // Renomeia para a extensão certa e calcula o resumo lendo em pedaços (arquivos grandes não cabem na memória).
  const destino = `${m.arquivo.replace(/\.bin$/, '')}.${tipo.ext}`;
  fs.renameSync(arquivo, path.join(config.midiaDir, destino));
  const hash = crypto.createHash('sha256');
  const leitor = fs.openSync(path.join(config.midiaDir, destino), 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let lidos = 0;
    while ((lidos = fs.readSync(leitor, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, lidos));
  } finally {
    fs.closeSync(leitor);
  }
  const alt = v.inteiroOpcional(altura, 'a altura', { min: 0, max: 16_384 }) ?? m.altura;
  const larg = v.inteiroOpcional(largura, 'a largura', { min: 0, max: 16_384 }) ?? m.largura;
  db.prepare(`UPDATE midias SET arquivo = ?, mime = ?, sha256 = ?, status = 'pronta', concluido_em = ?,
      duracao_s = COALESCE(?, duracao_s), largura = COALESCE(?, largura), altura = COALESCE(?, altura), qualidade = COALESCE(?, qualidade)
    WHERE id = ?`).run(destino, tipo.mime, hash.digest('hex'), agora(),
    v.inteiroOpcional(duracao, 'a duração', { min: 0, max: 86_400 }), larg, alt,
    qualidadePorAltura(alt ?? 0, larg ?? 0), m.id);
  return buscar(db, m.id);
}

/** Arte (capa, banner, logo, miniatura): vem inteira numa requisição. */
function salvarImagem(db, usuario, conteudo, { nome } = {}) {
  if (!Buffer.isBuffer(conteudo) || !conteudo.length) throw new ErroNegocio('Envie a imagem.', 422);
  if (conteudo.length > config.arteMaxBytes) throw new ErroNegocio(`Imagem maior que ${Math.round(config.arteMaxBytes / 1048576)} MB.`, 413);
  const tipo = detectarImagem(conteudo);
  if (!tipo) throw new ErroNegocio('Formato não aceito. Envie JPG, PNG, WEBP ou SVG.', 415);
  const relativo = novoArquivo(tipo.ext);
  fs.writeFileSync(path.join(config.midiaDir, relativo), conteudo, { flag: 'wx', mode: 0o600 });
  const r = db.prepare(`INSERT INTO midias (tipo, arquivo, nome_original, mime, tamanho, recebido, sha256, status, enviado_por, criado_em, concluido_em)
    VALUES ('imagem', ?, ?, ?, ?, ?, ?, 'pronta', ?, ?, ?)`)
    .run(relativo, nomeLimpo(nome, `arte.${tipo.ext}`), tipo.mime, conteudo.length, conteudo.length,
      crypto.createHash('sha256').update(conteudo).digest('hex'), usuario.id, agora(), agora());
  return buscar(db, Number(r.lastInsertRowid));
}

/** Legenda em WebVTT (o formato que o player usa). */
function salvarLegenda(db, usuario, conteudo, { nome, idioma, rotulo } = {}) {
  if (!Buffer.isBuffer(conteudo) || !conteudo.length) throw new ErroNegocio('Envie o arquivo da legenda.', 422);
  if (conteudo.length > config.legendaMaxBytes) throw new ErroNegocio(`Legenda maior que ${Math.round(config.legendaMaxBytes / 1024)} KB.`, 413);
  const texto = conteudo.toString('utf8');
  if (!/^﻿?WEBVTT/.test(texto)) throw new ErroNegocio('A legenda precisa estar em WebVTT (o arquivo começa com WEBVTT).', 415);
  const relativo = novoArquivo('vtt');
  fs.writeFileSync(path.join(config.midiaDir, relativo), conteudo, { flag: 'wx', mode: 0o600 });
  const r = db.prepare(`INSERT INTO midias (tipo, arquivo, nome_original, mime, tamanho, recebido, sha256, idioma, rotulo, status, enviado_por, criado_em, concluido_em)
    VALUES ('legenda', ?, ?, 'text/vtt', ?, ?, ?, ?, ?, 'pronta', ?, ?, ?)`)
    .run(relativo, nomeLimpo(nome, 'legenda.vtt'), conteudo.length, conteudo.length, crypto.createHash('sha256').update(conteudo).digest('hex'),
      v.idioma(idioma), v.opcional(rotulo, 'o rótulo da legenda', 60) ?? 'Português', usuario.id, agora(), agora());
  return buscar(db, Number(r.lastInsertRowid));
}

function buscar(db, id) {
  const m = db.prepare('SELECT * FROM midias WHERE id = ?').get(Number(id));
  if (!m) throw naoEncontrado('Arquivo');
  return m;
}

/** Onde este arquivo está sendo usado (impede apagar algo que está no ar). */
function usos(db, id) {
  const n = Number(id);
  const conta = (sql, vezes = 1) => db.prepare(sql).get(...Array(vezes).fill(n)).n;
  return conta('SELECT COUNT(*) AS n FROM canais WHERE logo_midia_id = ?')
    + conta('SELECT COUNT(*) AS n FROM titulos WHERE capa_midia_id = ? OR banner_midia_id = ? OR trailer_midia_id = ? OR video_midia_id = ?', 4)
    + conta('SELECT COUNT(*) AS n FROM episodios WHERE video_midia_id = ? OR thumb_midia_id = ?', 2)
    + conta('SELECT COUNT(*) AS n FROM legendas WHERE midia_id = ?')
    + conta('SELECT COUNT(*) AS n FROM destaques WHERE arte_midia_id = ?');
}

function excluir(db, id) {
  const m = buscar(db, id);
  if (usos(db, m.id) > 0) throw new ErroNegocio('Este arquivo está em uso. Troque-o no conteúdo antes de apagar.', 409);
  db.prepare('DELETE FROM midias WHERE id = ?').run(m.id);
  fs.rmSync(caminho(m), { force: true });
  return m;
}

/**
 * Entrega o arquivo com suporte a Range (o player pede pedaços para adiantar o vídeo).
 * Responde 206 com o trecho pedido ou 200 com o arquivo inteiro; 416 quando o trecho não existe.
 */
function enviar(req, res, m, { download = false, cache = 'private, max-age=0, no-store' } = {}) {
  const arquivo = caminho(m);
  let stat;
  try {
    stat = fs.statSync(arquivo);
  } catch {
    throw new ErroNegocio('Arquivo não encontrado no armazenamento.', 410);
  }
  const cabecalhos = {
    'Content-Type': m.mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    ...(download ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(m.nome_original)}` } : {}),
  };
  const faixa = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') || '');
  if (faixa && (faixa[1] || faixa[2])) {
    let inicio = faixa[1] ? Number(faixa[1]) : null;
    let fim = faixa[2] ? Number(faixa[2]) : null;
    if (inicio === null) {
      // "bytes=-500": os últimos 500 bytes.
      inicio = Math.max(0, stat.size - fim);
      fim = stat.size - 1;
    } else if (fim === null || fim >= stat.size) {
      fim = stat.size - 1;
    }
    if (inicio > fim || inicio >= stat.size) {
      res.set({ 'Content-Range': `bytes */${stat.size}` });
      throw new ErroNegocio('Trecho pedido fora do arquivo.', 416);
    }
    res.writeHead(206, { ...cabecalhos, 'Content-Range': `bytes ${inicio}-${fim}/${stat.size}`, 'Content-Length': fim - inicio + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(arquivo, { start: inicio, end: fim }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...cabecalhos, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(arquivo).on('error', () => res.destroy()).pipe(res);
}

module.exports = {
  detectarVideo, detectarImagem, qualidadePorAltura, abrirEnvioVideo, receberParte, concluirEnvioVideo,
  salvarImagem, salvarLegenda, buscar, usos, excluir, enviar, caminho,
};
