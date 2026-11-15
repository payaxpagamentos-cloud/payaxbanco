'use strict';

/*
 * Logo do cliente na ficha do boleto. Só PNG ou JPEG (nada de SVG, que pode levar script), pequeno,
 * guardado como data URI: a ficha mostra a imagem sem buscar nada fora e a política de segurança
 * da página (img-src 'self' data:) continua a mesma.
 */
const { ErroNegocio } = require('./erros');

const MAX_BYTES = 200 * 1024;
const FORMATO = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Valida a imagem enviada (data URI). Devolve o data URI aceito, ou null para remover o logo. */
function validar(imagem) {
  if (imagem === null || imagem === undefined || imagem === '') return null;
  const m = FORMATO.exec(String(imagem));
  if (!m) throw new ErroNegocio('Envie o logo em PNG ou JPEG.', 422);
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_BYTES) throw new ErroNegocio('O logo precisa ter no máximo 200 KB.', 422);
  // Confere o conteúdo, não só o nome do tipo.
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((m[1] === 'png' && !png) || (m[1] === 'jpeg' && !jpeg)) throw new ErroNegocio('O arquivo não é uma imagem PNG ou JPEG válida.', 422);
  return `data:image/${m[1]};base64,${m[2]}`;
}

/** O logo pronto para a ficha, ou null se não houver (ou se o gravado não passar na validação). */
const paraFicha = (logo) => (logo && FORMATO.test(logo) ? logo : null);

module.exports = { validar, paraFicha, MAX_BYTES };
