'use strict';

/**
 * Carimbo dos arquivos do player (data do script e do estilo). Vai no endereço deles na página da TV
 * e na resposta da batida: quando o sistema é atualizado, o carimbo muda, a TV percebe e recarrega
 * sozinha — inclusive navegador de TV que guarda tudo na memória.
 */
const fs = require('node:fs');
const path = require('node:path');

const pasta = path.join(__dirname, '..', '..', 'public', 'tv');

function carimboPlayer() {
  try {
    return ['player.js', 'tv.css'].map((f) => Math.floor(fs.statSync(path.join(pasta, f)).mtimeMs).toString(36)).join('');
  } catch {
    return '';
  }
}

module.exports = { carimboPlayer, pastaPlayer: pasta };
