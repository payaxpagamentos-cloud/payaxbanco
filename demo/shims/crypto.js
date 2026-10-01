'use strict';

/** Inteiro aleatório uniforme em [min, max) usando a criptografia do navegador (sem viés de módulo). */
function randomInt(min, max) {
  if (max === undefined) { max = min; min = 0; }
  const faixa = max - min;
  const limite = Math.floor(0x100000000 / faixa) * faixa;
  const buf = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(buf); } while (buf[0] >= limite);
  return min + (buf[0] % faixa);
}

module.exports = {
  randomUUID: () => globalThis.crypto.randomUUID(),
  randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  randomInt,
};
