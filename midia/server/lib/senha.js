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

// Usado quando o e-mail não existe: gasta o mesmo tempo de uma conferência de verdade,
// para o tempo de resposta não revelar quais e-mails têm cadastro.
const FALSA = hashSenha(crypto.randomBytes(12).toString('hex'));
const gastarTempo = (senha) => { verificarSenha(senha, FALSA); };

module.exports = { hashSenha, verificarSenha, gastarTempo };
