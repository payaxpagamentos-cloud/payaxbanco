'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.PDV_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PDV_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[Payax PDV] PDV_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['PDV_SECRET', 'PDV_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[Payax PDV] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.PDV_SECRET.length < 32) throw new Error('[Payax PDV] PDV_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.PDV_ADMIN_SENHA.length < 12) throw new Error('[Payax PDV] PDV_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o PDV é publicado: '' (raiz do domínio) ou um caminho, como '/pdv'.
const basePath = String(process.env.PDV_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3600,
  dbFile: process.env.PDV_DB || path.join(__dirname, '..', 'data', 'pdv.db'),
  secret,
  // Chave das credenciais guardadas (token do IXC, chaves das maquininhas): derivada do segredo das sessões.
  chaveCredenciais: crypto.createHash('sha256').update(`credenciais:${secret}`).digest(),
  tokenTtlSeconds: 12 * 60 * 60,
  trustProxy: process.env.PDV_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.PDV_LIMITE_LOGIN) || 10,
  // Só aceita endereços https:// no IXC e nas maquininhas, a menos que PDV_HTTP=1 (servidor na rede interna).
  permitirHttp: process.env.PDV_HTTP === '1',
  ixcTimeoutMs: Number(process.env.PDV_IXC_TIMEOUT) || 8000,
  // Cobrança no cartão sem resposta da maquininha por este tempo é dada como expirada.
  cartaoExpiraMin: Number(process.env.PDV_CARTAO_EXPIRA_MIN) || 5,
  // Fuso do caixa, dos relatórios e da conferência.
  fuso: process.env.PDV_FUSO || 'America/Sao_Paulo',
  admin: {
    nome: process.env.PDV_ADMIN_NOME || 'Master',
    email: process.env.PDV_ADMIN_EMAIL || 'master@pdv.com.br',
    senha: process.env.PDV_ADMIN_SENHA || 'master123',
  },
};
