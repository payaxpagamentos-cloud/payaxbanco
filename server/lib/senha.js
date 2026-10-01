'use strict';

const crypto = require('node:crypto');
const config = require('../config');

// ---------- Senhas da equipe (texto livre) ----------
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

// ---------- Senhas numéricas do cliente (teclado virtual) ----------
// A senha é combinada com um segredo do servidor (pepper) antes do scrypt: um vazamento só do banco de
// dados não permite testar as 10^6 combinações. O custo é menor porque cada login testa até 64 candidatos.
const CUSTO_NUMERICO = 2048;
const comPepper = (senha) => crypto.createHmac('sha256', config.pepper).update(String(senha)).digest();

function hashNumerica(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(comPepper(senha), salt, 32, { N: CUSTO_NUMERICO });
  return `scryptn$${CUSTO_NUMERICO}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const scryptAsync = (senha, salt, n) => new Promise((resolve, reject) => {
  crypto.scrypt(comPepper(senha), salt, 32, { N: n }, (err, k) => (err ? reject(err) : resolve(k)));
});

/** Verifica se algum dos candidatos corresponde à senha armazenada. Testa todos (tempo constante). */
async function verificarNumerica(candidatos, armazenado) {
  const [alg, n, saltHex, hashHex] = String(armazenado ?? '').split('$');
  if (alg !== 'scryptn' || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const salt = Buffer.from(saltHex, 'hex');
  const calculados = await Promise.all(candidatos.map((c) => scryptAsync(c, salt, Number(n))));
  return calculados.reduce((ok, k) => crypto.timingSafeEqual(esperado, k) || ok, false);
}

module.exports = { hashSenha, verificarSenha, hashNumerica, verificarNumerica };
