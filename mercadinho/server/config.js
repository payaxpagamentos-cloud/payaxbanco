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
  // Fotos dos produtos: ficam ao lado do banco (a mesma pasta que entra na cópia de segurança).
  fotosDir: process.env.MERCADO_FOTOS || path.join(path.dirname(process.env.MERCADO_DB || path.join(__dirname, '..', 'data', 'mercadinho.db')), 'fotos'),
  fotoMaximoBytes: Number(process.env.MERCADO_FOTO_MAX_BYTES) || 2 * 1024 * 1024,
  // Vídeos e imagens da vitrine: também ao lado do banco, para entrar na cópia de segurança.
  vitrineDir: process.env.MERCADO_VITRINE || path.join(path.dirname(process.env.MERCADO_DB || path.join(__dirname, '..', 'data', 'mercadinho.db')), 'vitrine'),
  vitrineVideoMaxBytes: Number(process.env.MERCADO_VITRINE_VIDEO_MAX_MB || 80) * 1024 * 1024,
  vitrineImagemMaxBytes: 8 * 1024 * 1024,
  secret,
  tokenTtlSeconds: 12 * 60 * 60,
  // "Manter conectado" na tela de entrada: sessão mais longa, por opção de quem entra.
  tokenTtlLembrarSeconds: Number(process.env.MERCADO_TTL_LEMBRAR_DIAS || 7) * 24 * 60 * 60,
  // O terminal do balcão fica pareado por um ano (a administração pode desativá-lo a qualquer momento).
  terminalTtlSeconds: Number(process.env.MERCADO_TERMINAL_TTL_DIAS || 365) * 24 * 60 * 60,
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
