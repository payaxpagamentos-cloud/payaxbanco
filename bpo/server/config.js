'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.BPO_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.BPO_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[PAY AX BPO] BPO_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['BPO_SECRET', 'BPO_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[PAY AX BPO] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.BPO_SECRET.length < 32) throw new Error('[PAY AX BPO] BPO_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.BPO_ADMIN_SENHA.length < 12) throw new Error('[PAY AX BPO] BPO_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

module.exports = {
  producao,
  port: Number(process.env.PORT) || 3100,
  dbFile: process.env.BPO_DB || path.join(__dirname, '..', 'data', 'bpo.db'),
  secret,
  tokenTtlSeconds: 8 * 60 * 60,
  trustProxy: process.env.BPO_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.BPO_LIMITE_LOGIN) || 10,
  // Tolerância, em dias, entre a data do extrato e a do lançamento para sugerir conciliação.
  toleranciaConciliacaoDias: Number(process.env.BPO_TOLERANCIA_DIAS) || 3,
  admin: {
    nome: process.env.BPO_ADMIN_NOME || 'Administrador BPO',
    email: process.env.BPO_ADMIN_EMAIL || 'admin@bpo.payax.com.br',
    senha: process.env.BPO_ADMIN_SENHA || 'admin123',
  },
};
