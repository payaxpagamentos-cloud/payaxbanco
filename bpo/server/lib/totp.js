'use strict';

const crypto = require('node:crypto');

// Autenticação em duas etapas por aplicativo (TOTP, RFC 6238): Google Authenticator, Microsoft Authenticator, Authy…
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PASSO = 30;

function base32(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g).map((c) => ALFABETO[parseInt(c.padEnd(5, '0'), 2)]).join('');
}

function deBase32(texto) {
  const bits = String(texto).toUpperCase().replace(/[^A-Z2-7]/g, '').split('').map((c) => ALFABETO.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
}

const novoSegredo = () => base32(crypto.randomBytes(20));

function codigo(segredo, passo) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', deBase32(segredo)).update(contador).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const passoAtual = (agora = Date.now()) => Math.floor(agora / 1000 / PASSO);

/**
 * Confere o código aceitando um passo antes e um depois (relógio do celular). Retorna o passo usado,
 * ou null. `ultimoPasso` impede reutilizar o mesmo código.
 */
function verificar(segredo, informado, ultimoPasso = null, agora = Date.now()) {
  const c = String(informado ?? '').replace(/\D/g, '');
  if (c.length !== 6 || !segredo) return null;
  const atual = passoAtual(agora);
  for (const p of [atual, atual - 1, atual + 1]) {
    if (ultimoPasso !== null && p <= ultimoPasso) continue;
    if (crypto.timingSafeEqual(Buffer.from(codigo(segredo, p)), Buffer.from(c))) return p;
  }
  return null;
}

const uri = (segredo, conta, emissor = 'PAY AX BPO') =>
  `otpauth://totp/${encodeURIComponent(`${emissor}:${conta}`)}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=6&period=${PASSO}`;

module.exports = { novoSegredo, codigo, passoAtual, verificar, uri, base32, deBase32 };
