'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.MERCADO_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.MERCADO_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[Mercadinho] MERCADO_SECRET não definido: usando segredo temporário (as sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['MERCADO_SECRET', 'MERCADO_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[Mercadinho] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.MERCADO_SECRET.length < 32) throw new Error('[Mercadinho] MERCADO_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.MERCADO_ADMIN_SENHA.length < 12) throw new Error('[Mercadinho] MERCADO_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o sistema é publicado: '' (raiz do domínio) ou um caminho, como '/mercadinho'.
const basePath = String(process.env.MERCADO_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3300,
  dbFile: process.env.MERCADO_DB || path.join(__dirname, '..', 'data', 'mercadinho.db'),
  secret,
  tokenTtlSeconds: 12 * 60 * 60,
  trustProxy: process.env.MERCADO_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.MERCADO_LIMITE_LOGIN) || 10,
  // Fuso usado nos fechamentos de caixa, nas competências e nos relatórios.
  fuso: process.env.MERCADO_FUSO || 'America/Sao_Paulo',
  maquininha: {
    // Tempo máximo de espera de cada chamada à maquininha (ponte TEF local ou API do provedor).
    timeoutMs: Number(process.env.MERCADO_MAQUININHA_TIMEOUT_MS) || 8000,
    // Minutos até uma cobrança pendente na maquininha ser considerada expirada.
    expirarMin: Number(process.env.MERCADO_MAQUININHA_EXPIRAR_MIN) || 5,
  },
  admin: {
    nome: process.env.MERCADO_ADMIN_NOME || 'Administrador',
    email: process.env.MERCADO_ADMIN_EMAIL || 'admin@mercadinho.com.br',
    senha: process.env.MERCADO_ADMIN_SENHA || 'admin123',
  },
};
