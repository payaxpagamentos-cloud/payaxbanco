'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { ErroNegocio } = require('./erros');

/**
 * Fotos dos produtos. O arquivo fica em data/fotos (junto do banco, para entrar na mesma cópia de
 * segurança) e o produto guarda só o nome do arquivo. O nome é gerado aqui, nunca vem do navegador.
 */
const TIPOS = {
  jpg: { mime: 'image/jpeg', assinatura: [0xff, 0xd8, 0xff] },
  png: { mime: 'image/png', assinatura: [0x89, 0x50, 0x4e, 0x47] },
  webp: { mime: 'image/webp', assinatura: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" + "WEBP" no byte 8
};

const pasta = () => {
  fs.mkdirSync(config.fotosDir, { recursive: true });
  return config.fotosDir;
};

/** Descobre o formato pelos primeiros bytes — o cabeçalho enviado pelo navegador não é prova de nada. */
function formatoDe(buffer) {
  for (const [ext, { assinatura }] of Object.entries(TIPOS)) {
    if (assinatura.every((b, i) => buffer[i] === b)) {
      if (ext === 'webp' && buffer.subarray(8, 12).toString('latin1') !== 'WEBP') continue;
      return ext;
    }
  }
  return null;
}

/** Grava a foto do produto e devolve o nome do arquivo. Apaga a anterior, se houver. */
function guardar(buffer, produto_id, anterior = null) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ErroNegocio('Envie uma imagem.', 422);
  if (buffer.length > config.fotoMaximoBytes) {
    throw new ErroNegocio(`A foto é grande demais (máximo de ${Math.round(config.fotoMaximoBytes / 1024 / 1024)} MB).`, 413);
  }
  const ext = formatoDe(buffer);
  if (!ext) throw new ErroNegocio('Formato não aceito. Use JPEG, PNG ou WebP.', 422);

  const nome = `${produto_id}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(pasta(), nome), buffer, { mode: 0o644 });
  if (anterior) apagar(anterior);
  return nome;
}

/** Apaga o arquivo da foto. O nome é sempre o que está no banco, nunca um caminho vindo de fora. */
function apagar(nome) {
  if (!nome || !/^[\w.-]+$/.test(nome)) return false;
  try {
    fs.unlinkSync(path.join(config.fotosDir, nome));
    return true;
  } catch {
    return false; // já não existia
  }
}

const caminho = (nome) => (nome && /^[\w.-]+$/.test(nome) ? path.join(config.fotosDir, nome) : null);

module.exports = { guardar, apagar, caminho, pasta, formatoDe, TIPOS };
