'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.PABX_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PABX_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[PABX] PABX_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['PABX_SECRET', 'PABX_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[PABX] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.PABX_SECRET.length < 32) throw new Error('[PABX] PABX_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.PABX_ADMIN_SENHA.length < 12) throw new Error('[PABX] PABX_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o painel é publicado: '' (raiz do domínio) ou um caminho, como '/pabx'.
const basePath = String(process.env.PABX_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3300,
  dbFile: process.env.PABX_DB || path.join(__dirname, '..', 'data', 'pabx.db'),
  secret,
  tokenTtlSeconds: 12 * 60 * 60,
  trustProxy: process.env.PABX_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.PABX_LIMITE_LOGIN) || 10,
  // Fuso das datas do dashboard e dos relatórios.
  fuso: process.env.PABX_FUSO || 'America/Sao_Paulo',
  admin: {
    nome: process.env.PABX_ADMIN_NOME || 'Master',
    email: process.env.PABX_ADMIN_EMAIL || 'master@pabx.com.br',
    senha: process.env.PABX_ADMIN_SENHA || 'master123',
  },
};
