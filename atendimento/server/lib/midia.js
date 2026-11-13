'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

/**
 * Arquivos (áudios, fotos e documentos que o cliente manda) ficam fora do banco, em `data/arquivos`,
 * com nome aleatório. O nome original só aparece na tela; o arquivo em si nunca é servido pelo nome dele.
 * Inclua esta pasta no backup do servidor: o backup do banco não cobre os arquivos.
 */

const EXTENSOES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/amr': '.amr', 'audio/aac': '.aac', 'audio/wav': '.wav',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

const extensaoDe = (mime) => EXTENSOES[String(mime ?? '').split(';')[0].trim().toLowerCase()] ?? '.bin';

/** Grava o arquivo e devolve o nome interno (relativo a ATEND_ARQUIVOS). */
function guardar(buffer, mime) {
  fs.mkdirSync(config.arquivos, { recursive: true });
  const nome = `${crypto.randomBytes(16).toString('hex')}${extensaoDe(mime)}`;
  fs.writeFileSync(path.join(config.arquivos, nome), buffer, { mode: 0o600 });
  return nome;
}

/** Caminho no disco de um arquivo interno. Recusa nome com caminho (nunca sai da pasta). */
function caminho(nome) {
  const n = String(nome ?? '');
  if (!/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/i.test(n)) return null;
  const alvo = path.join(config.arquivos, n);
  return alvo.startsWith(path.resolve(config.arquivos) + path.sep) || path.dirname(alvo) === path.resolve(config.arquivos) ? alvo : null;
}

const existe = (nome) => { const c = caminho(nome); return Boolean(c && fs.existsSync(c)); };

function apagar(nome) {
  const c = caminho(nome);
  if (c) { try { fs.unlinkSync(c); } catch { /* já não está lá */ } }
}

module.exports = { guardar, caminho, existe, apagar, extensaoDe };
