'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { ErroNegocio } = require('./erros');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Reconhecido pelo conteúdo (assinatura do arquivo), não pelo nome nem pelo cabeçalho enviado. */
function detectarTipo(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', tipo: 'imagem' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png', tipo: 'imagem' };
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp', tipo: 'imagem' };
  if (b.length >= 12 && b.subarray(4, 8).toString() === 'ftyp') {
    const marca = b.subarray(8, 12).toString();
    if (marca === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', tipo: 'video' };
    return { mime: 'video/mp4', ext: 'mp4', tipo: 'video' };
  }
  if (b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mime: 'video/webm', ext: 'webm', tipo: 'video' };
  return null;
}

/** Tamanho da imagem (PNG, JPEG e WEBP), para avisar quando o criativo não combina com a orientação da TV. */
function dimensoesImagem(b, mime) {
  try {
    if (mime === 'image/png') return { largura: b.readUInt32BE(16), altura: b.readUInt32BE(20) };
    if (mime === 'image/webp') {
      const formato = b.subarray(12, 16).toString();
      if (formato === 'VP8X') return { largura: (b.readUIntLE(24, 3) & 0xffffff) + 1, altura: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
      if (formato === 'VP8 ') return { largura: b.readUInt16LE(26) & 0x3fff, altura: b.readUInt16LE(28) & 0x3fff };
      if (formato === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { largura: (bits & 0x3fff) + 1, altura: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    // JPEG: percorre os marcadores até o início do quadro (SOF0..SOF15, menos os de reinício).
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marcador = b[i + 1];
      if (marcador === 0xd8 || marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) { i += 2; continue; }
      const tamanho = b.readUInt16BE(i + 2);
      if (marcador >= 0xc0 && marcador <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marcador)) {
        return { altura: b.readUInt16BE(i + 5), largura: b.readUInt16BE(i + 7) };
      }
      i += 2 + tamanho;
    }
  } catch { /* arquivo truncado: segue sem as dimensões */ }
  return null;
}

/** Percorre as caixas (atoms) do MP4/MOV procurando 'mvhd' (duração) e 'tkhd' (tamanho do vídeo). */
function lerMp4(b) {
  let duracao = null;
  let largura = null;
  let altura = null;
  const andar = (inicio, fim, nivel) => {
    let p = inicio;
    while (p + 8 <= fim && nivel < 6) {
      let tamanho = b.readUInt32BE(p);
      const nome = b.subarray(p + 4, p + 8).toString('latin1');
      let corpo = p + 8;
      if (tamanho === 1) { tamanho = Number(b.readBigUInt64BE(p + 8)); corpo = p + 16; }
      if (tamanho === 0) tamanho = fim - p;
      if (tamanho < 8 || p + tamanho > fim) return;
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'].includes(nome)) {
        andar(corpo, p + tamanho, nivel + 1);
      } else if (nome === 'mvhd' && duracao === null) {
        // versão 0: criação e modificação em 4 bytes (escala em +12, duração em +16); versão 1: em 8 bytes (+20 e +24).
        const versao = b[corpo];
        const escala = b.readUInt32BE(corpo + (versao === 1 ? 20 : 12));
        const total = versao === 1 ? Number(b.readBigUInt64BE(corpo + 24)) : b.readUInt32BE(corpo + 16);
        if (escala > 0 && total > 0) duracao = total / escala;
      } else if (nome === 'tkhd' && largura === null) {
        // Tamanho do vídeo no fim da caixa, em ponto fixo 16.16.
        const versao = b[corpo];
        const base = corpo + (versao === 1 ? 88 : 76);
        if (base + 8 <= fim) {
          const l = b.readUInt32BE(base) / 65536;
          const a = b.readUInt32BE(base + 4) / 65536;
          if (l > 0 && a > 0) { largura = Math.round(l); altura = Math.round(a); }
        }
      }
      p += tamanho;
    }
  };
  try { andar(0, b.length, 0); } catch { /* arquivo truncado */ }
  return { duracao, largura, altura };
}

/** Duração em segundos (arredondada para cima) e tamanho do vídeo, quando o arquivo informa. */
function lerVideo(b, mime) {
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    const { duracao, largura, altura } = lerMp4(b);
    return { duracao_s: duracao ? Math.max(1, Math.ceil(duracao)) : null, largura, altura };
  }
  return { duracao_s: null, largura: null, altura: null };
}

const orientacaoDe = (largura, altura) => (largura && altura ? (altura > largura ? 'retrato' : 'paisagem') : null);

/**
 * Grava o arquivo da mídia fora da pasta pública, com nome aleatório, e devolve o que foi lido dele.
 * `duracaoInformada` vale para imagens e para vídeos cujo arquivo não traz a duração (WEBM, por exemplo).
 */
function salvar(conteudo, { duracaoInformada, duracaoImagemPadrao }) {
  if (!Buffer.isBuffer(conteudo) || conteudo.length === 0) throw new ErroNegocio('Envie o arquivo da mídia.', 422);
  if (conteudo.length > config.midiaMaxBytes) throw new ErroNegocio(`Arquivo maior que ${Math.round(config.midiaMaxBytes / 1048576)} MB.`, 413);
  const t = detectarTipo(conteudo);
  if (!t) throw new ErroNegocio('Formato não aceito. Envie imagem (JPG, PNG, WEBP) ou vídeo (MP4, MOV, WEBM).', 415);

  const lido = t.tipo === 'imagem'
    ? { ...(dimensoesImagem(conteudo, t.mime) ?? {}), duracao_s: null }
    : lerVideo(conteudo, t.mime);
  const duracao = t.tipo === 'video'
    ? (lido.duracao_s ?? duracaoInformada ?? null)
    : (duracaoInformada ?? duracaoImagemPadrao);
  if (!duracao) throw new ErroNegocio('Não foi possível ler a duração do vídeo. Informe a duração em segundos.', 422);
  if (duracao < 1 || duracao > 600) throw new ErroNegocio('A duração deve ficar entre 1 e 600 segundos.', 422);

  const arquivo = `${crypto.randomBytes(20).toString('hex')}.${t.ext}`;
  fs.mkdirSync(config.arquivos, { recursive: true });
  fs.writeFileSync(path.join(config.arquivos, arquivo), conteudo, { flag: 'wx', mode: 0o600 });
  return {
    arquivo,
    mime: t.mime,
    tipo: t.tipo,
    bytes: conteudo.length,
    sha256: sha256(conteudo),
    largura: lido.largura ?? null,
    altura: lido.altura ?? null,
    orientacao: orientacaoDe(lido.largura, lido.altura),
    duracao_s: Math.round(duracao),
  };
}

const caminho = (m) => path.join(config.arquivos, path.basename(m.arquivo));

/** Apaga o arquivo de uma mídia removida (o registro sai do banco em transação; o arquivo, aqui). */
function remover(m) {
  try { fs.unlinkSync(caminho(m)); } catch { /* já não existe */ }
}

const tamanhoNoDisco = () => {
  try {
    return fs.readdirSync(config.arquivos).reduce((t, f) => {
      try { return t + fs.statSync(path.join(config.arquivos, f)).size; } catch { return t; }
    }, 0);
  } catch { return 0; }
};

module.exports = { detectarTipo, dimensoesImagem, lerVideo, lerMp4, salvar, caminho, remover, sha256, orientacaoDe, tamanhoNoDisco };
