'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.PABX_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PABX_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[ZOE PABX] PABX_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['PABX_SECRET', 'PABX_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[ZOE PABX] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.PABX_SECRET.length < 32) throw new Error('[ZOE PABX] PABX_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.PABX_ADMIN_SENHA.length < 12) throw new Error('[ZOE PABX] PABX_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o painel é publicado: '' (raiz do domínio) ou um caminho, como '/pabx'.
const basePath = String(process.env.PABX_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');

/** Telefone do painel: só liga com um endereço wss:// válido. */
function webrtc() {
  const wss = String(process.env.PABX_WEBRTC_WSS || '').trim();
  let url = null;
  try { url = wss ? new URL(wss) : null; } catch { url = null; }
  if (wss && (!url || url.protocol !== 'wss:')) console.warn('[ZOE PABX] PABX_WEBRTC_WSS deve começar com wss://; o telefone do painel ficará desligado.');
  const ok = url && url.protocol === 'wss:';
  return {
    wss: ok ? url.toString() : null,
    origem: ok ? `wss://${url.host}` : null,
    dominio: process.env.PABX_SIP_DOMINIO || (ok ? url.hostname : null),
    stun: String(process.env.PABX_STUN ?? 'stun:stun.l.google.com:19302').split(',').map((x) => x.trim()).filter(Boolean),
  };
}

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3300,
  dbFile: process.env.PABX_DB || path.join(__dirname, '..', 'data', 'pabx.db'),
  secret,
  tokenTtlSeconds: 12 * 60 * 60,
  trustProxy: process.env.PABX_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.PABX_LIMITE_LOGIN) || 10,
  // Telefone no painel (WebRTC): endereço WSS do Asterisk (ex.: wss://pbx.seudominio.com.br:8089/ws), domínio SIP e STUN.
  webrtc: webrtc(),
  // Fuso das datas do dashboard e dos relatórios.
  fuso: process.env.PABX_FUSO || 'America/Sao_Paulo',
  admin: {
    nome: process.env.PABX_ADMIN_NOME || 'Master',
    email: process.env.PABX_ADMIN_EMAIL || 'master@pabx.com.br',
    senha: process.env.PABX_ADMIN_SENHA || 'master123',
  },
};
