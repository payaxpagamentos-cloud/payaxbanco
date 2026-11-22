'use strict';

/**
 * Verificação em duas etapas com aplicativo autenticador (Google Authenticator, Authy, o do iPhone…).
 * É o padrão TOTP (RFC 6238): um segredo guardado no celular e aqui, e um código de 6 números que muda
 * a cada 30 segundos. Não depende de e-mail nem de SMS.
 */
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const novoSegredo = () => Array.from(crypto.randomBytes(20), (b) => B32[b % 32]).join('');

function decodificar(segredo) {
  let bits = '';
  for (const c of String(segredo).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codigoEm(segredo, passo) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', decodificar(segredo)).update(contador).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Aceita o código de agora e o dos 30 segundos vizinhos (relógio do celular nunca é exato). */
function conferir(segredo, codigo, agoraMs = Date.now()) {
  const limpo = String(codigo ?? '').replace(/\D/g, '');
  if (limpo.length !== 6 || !segredo) return false;
  const passo = Math.floor(agoraMs / 30_000);
  let ok = false;
  for (const d of [-1, 0, 1]) {
    const esperado = Buffer.from(codigoEm(segredo, passo + d));
    if (crypto.timingSafeEqual(esperado, Buffer.from(limpo))) ok = true;
  }
  return ok;
}

const endereco = (segredo, conta, emissor) =>
  `otpauth://totp/${encodeURIComponent(`${emissor}:${conta}`)}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&digits=6&period=30`;

/** Códigos de reserva (uso único) para quando a pessoa perde o celular. */
const novosCodigosReserva = () => Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
const resumo = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

module.exports = { novoSegredo, codigoEm, conferir, endereco, novosCodigosReserva, resumo };
