'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.MIDIA_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.MIDIA_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[Mídia Indoor] MIDIA_SECRET não definido: usando segredo temporário (sessões e TVs pareadas caem ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['MIDIA_SECRET', 'MIDIA_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[Mídia Indoor] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.MIDIA_SECRET.length < 32) throw new Error('[Mídia Indoor] MIDIA_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.MIDIA_ADMIN_SENHA.length < 12) throw new Error('[Mídia Indoor] MIDIA_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o painel é publicado: '' (raiz do domínio) ou um caminho, como '/midia'.
const basePath = String(process.env.MIDIA_BASE_PATH ?? '/midia').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3600,
  dbFile: process.env.MIDIA_DB || path.join(__dirname, '..', 'data', 'midia.db'),
  // Arquivos das mídias (vídeos e imagens) ficam fora da pasta pública, com nome aleatório.
  arquivos: process.env.MIDIA_ARQUIVOS || path.join(__dirname, '..', 'data', 'arquivos'),
  secret,
  tokenTtlSeconds: 12 * 60 * 60,
  trustProxy: process.env.MIDIA_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.MIDIA_LIMITE_LOGIN) || 10,
  // Fuso usado na programação das TVs (dias e horários das campanhas) e nos relatórios.
  fuso: process.env.MIDIA_FUSO || 'America/Sao_Paulo',
  // Tamanho máximo de um arquivo de mídia enviado ao painel.
  midiaMaxBytes: (Number(process.env.MIDIA_MAX_MB) || 200) * 1024 * 1024,
  admin: {
    nome: process.env.MIDIA_ADMIN_NOME || 'Master',
    email: process.env.MIDIA_ADMIN_EMAIL || 'master@midia.com.br',
    senha: process.env.MIDIA_ADMIN_SENHA || 'master123',
  },
};
