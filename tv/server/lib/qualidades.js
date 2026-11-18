'use strict';

/**
 * Vocabulário de qualidade de imagem, num lugar só.
 *
 * O mesmo título pode ter várias versões do arquivo — SD, HD, Full HD e 4K. O plano do
 * assinante diz até onde ele pode subir, e o player escolhe a melhor versão permitida.
 */

/** Da pior para a melhor: a ordem vale para comparar planos e para montar o menu do player. */
const ORDEM = ['sd', 'hd', 'fullhd', '4k'];

const ROTULOS = { sd: 'SD', hd: 'HD', fullhd: 'Full HD', '4k': '4K Ultra HD' };
const LINHAS = { sd: '480p', hd: '720p', fullhd: '1080p', '4k': '2160p' };

/**
 * Qualidade a partir das medidas do vídeo.
 *
 * Só a altura não basta: um filme em tela larga de verdade (2.39:1) tem 3840 de largura e
 * 1608 de altura — é 4K, e pela altura cairia em Full HD. Por isso vale a largura também.
 */
const porMedidas = (largura, altura) => {
  const l = Number(largura) || 0;
  const a = Number(altura) || 0;
  if (!l && !a) return null;
  if (a >= 1700 || l >= 3400) return '4k';
  if (a >= 1000 || l >= 1800) return 'fullhd';
  if (a >= 700 || l >= 1200) return 'hd';
  return 'sd';
};

/** Atalho de quem só tem a altura em mãos. */
const porAltura = (altura) => porMedidas(0, altura);

/** Posição na escala (-1 quando não conhecemos a qualidade). */
const nivel = (q) => ORDEM.indexOf(String(q ?? ''));

/** Esta qualidade cabe no limite do plano? */
const cabeNoPlano = (q, limite) => nivel(q) <= Math.max(0, nivel(limite));

/** A melhor da lista que o plano permite. */
const melhorPermitida = (lista, limite) => lista
  .filter((q) => cabeNoPlano(q, limite))
  .sort((a, b) => nivel(b) - nivel(a))[0] ?? null;

const rotulo = (q) => ROTULOS[q] ?? String(q ?? '').toUpperCase();
const linha = (q) => LINHAS[q] ?? null;

module.exports = { ORDEM, ROTULOS, LINHAS, porMedidas, porAltura, nivel, cabeNoPlano, melhorPermitida, rotulo, linha };
