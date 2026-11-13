'use strict';

const crypto = require('node:crypto');
const config = require('../config');

/**
 * Segredos que precisam ser lidos de volta (token da Cloud API, segredo do app, cabeçalhos das
 * ferramentas da empresa) ficam cifrados com AES-256-GCM a partir do segredo do servidor.
 * Trocar ATEND_SECRET invalida o que estava guardado: a empresa informa o token de novo.
 */
const chave = (dominio) => crypto.createHash('sha256').update(`atend:${dominio}:${config.secret}`).digest();

function cifrar(texto, dominio = 'geral') {
  if (texto === null || texto === undefined || texto === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(dominio), iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), dados].map((b) => b.toString('base64url')).join('.');
}

function decifrar(guardado, dominio = 'geral') {
  if (!guardado) return null;
  try {
    const [iv, tag, dados] = String(guardado).split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', chave(dominio), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(dados), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Compara dois segredos em tempo constante (assinatura de webhook, chave de API). */
function iguais(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { cifrar, decifrar, iguais };
