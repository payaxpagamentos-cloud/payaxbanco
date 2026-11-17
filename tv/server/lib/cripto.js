'use strict';

const crypto = require('node:crypto');
const config = require('../config');

/** Assinatura curta (HMAC do segredo do servidor) usada nos links de reprodução e de segmentos. */
const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(String(dados)).digest('base64url').slice(0, 43);

/** Comparação em tempo constante de duas assinaturas. */
function confere(esperado, recebido) {
  const a = Buffer.from(String(esperado));
  const b = Buffer.from(String(recebido ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = { assinar, confere, sha256 };
