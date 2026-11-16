'use strict';

const crypto = require('node:crypto');

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verificarSenha(senha, armazenado) {
  const [alg, saltHex, hashHex] = String(armazenado).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = crypto.scryptSync(String(senha), Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

/**
 * Senha provisória para entregar ao cliente (ex.: "k7m2qx-9fa3"): gerada com o sorteio criptográfico do
 * sistema, sem letras e números que se confundem ao digitar (0/o, 1/l/i).
 */
function senhaProvisoria() {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
  const sorteio = require('node:crypto').randomBytes(10);
  const t = [...sorteio].map((b) => alfabeto[b % alfabeto.length]).join('');
  return `${t.slice(0, 6)}-${t.slice(6, 10)}`;
}

module.exports = { hashSenha, verificarSenha, senhaProvisoria };
