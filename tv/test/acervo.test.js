'use strict';

/** Escolha do arquivo e conferência de licença na importação de acervo público. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const acervo = require('../server/lib/acervo');

const ficha = (arquivos) => ({ metadata: { identifier: 'exemplo' }, files: arquivos });

test('escolhe o arquivo pela resolução de verdade, não pelo nome', () => {
  // O acervo chama de "720p" uma cópia que é 360p: quem manda são as medidas.
  const f = acervo.melhorArquivo(ficha([
    { name: 'filme_720p.mp4', size: 80e6, width: 862, height: 360, source: 'derivative' },
    { name: 'filme_1080p.mkv', size: 570e6, width: 1920, height: 800, source: 'original' },
  ]));
  assert.equal(f.nome, 'filme_1080p.mkv');
  assert.equal(f.altura, 800);
  assert.equal(f.precisaConverter, true, 'mkv precisa virar mp4 na entrada');
});

test('com a mesma resolução, prefere o MP4 (toca direto no navegador)', () => {
  const f = acervo.melhorArquivo(ficha([
    { name: 'filme.webm', size: 600e6, width: 1920, height: 1080, source: 'original' },
    { name: 'filme.mp4', size: 400e6, width: 1920, height: 1080, source: 'original' },
  ]));
  assert.equal(f.nome, 'filme.mp4');
  assert.equal(f.precisaConverter, false);
});

test('ignora arquivo pequeno demais e master gigante', () => {
  const f = acervo.melhorArquivo(ficha([
    { name: 'trailer.mp4', size: 900_000, width: 1920, height: 1080, source: 'original' },
    { name: 'master.mov', size: 210_000e6, width: 1920, height: 1080, source: 'original' },
    { name: 'filme.mp4', size: 300e6, width: 1280, height: 720, source: 'original' },
  ]));
  assert.equal(f.nome, 'filme.mp4');
});

test('item sem vídeo aproveitável devolve nulo', () => {
  assert.equal(acervo.melhorArquivo(ficha([{ name: 'capa.jpg', size: 50e6 }])), null);
});

test('licença livre e coleção de domínio público liberam a importação', () => {
  assert.equal(acervo.podeRedistribuir({ licenca: 'http://creativecommons.org/licenses/by/3.0/', colecoes: [] }), true);
  assert.equal(acervo.podeRedistribuir({ licenca: 'https://creativecommons.org/publicdomain/zero/1.0/', colecoes: [] }), true);
  assert.equal(acervo.podeRedistribuir({ licenca: null, colecoes: ['feature_films'] }), true);
});

test('sem licença e fora das coleções conhecidas, não importa sozinho', () => {
  assert.equal(acervo.podeRedistribuir({ licenca: null, colecoes: ['opensource_movies'] }), false);
  assert.equal(acervo.podeRedistribuir({ licenca: 'https://exemplo.com/licenca', colecoes: [] }), false);
});

test('licença "sem derivadas" não entra: gerar Full HD, HD e SD é criar derivada', () => {
  assert.equal(acervo.podeRedistribuir({ licenca: 'http://creativecommons.org/licenses/by-nd/4.0/', colecoes: [] }), false);
});
