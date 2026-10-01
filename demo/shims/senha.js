'use strict';

/* Demonstração no navegador: hash simples (FNV-1a). A versão instalada usa scrypt. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
const hashSenha = (senha) => `demo$${fnv(`payax:${senha}`)}`;
const verificarSenha = (senha, armazenado) => hashSenha(senha) === armazenado;
const hashNumerica = (senha) => `demon$${fnv(`payax:n:${senha}`)}`;
const verificarNumerica = async (candidatos, armazenado) => candidatos.some((c) => hashNumerica(c) === armazenado);
module.exports = { hashSenha, verificarSenha, hashNumerica, verificarNumerica };
