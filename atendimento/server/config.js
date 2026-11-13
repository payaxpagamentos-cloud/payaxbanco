'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.ATEND_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.ATEND_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[ZOE Atende] ATEND_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['ATEND_SECRET', 'ATEND_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[ZOE Atende] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.ATEND_SECRET.length < 32) throw new Error('[ZOE Atende] ATEND_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.ATEND_ADMIN_SENHA.length < 12) throw new Error('[ZOE Atende] ATEND_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o painel é publicado: '' (raiz do domínio) ou um caminho, como '/atendimento'.
const basePath = String(process.env.ATEND_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3600,
  dbFile: process.env.ATEND_DB || path.join(__dirname, '..', 'data', 'atendimento.db'),
  arquivos: process.env.ATEND_ARQUIVOS || path.join(__dirname, '..', 'data', 'arquivos'),
  arquivoMaxMb: Number(process.env.ATEND_ARQUIVO_MAX_MB) || 16,
  secret,
  tokenTtlSeconds: 12 * 60 * 60,
  trustProxy: process.env.ATEND_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.ATEND_LIMITE_LOGIN) || 10,
  // Fuso usado no horário de atendimento, nos dashboards e nos relatórios.
  fuso: process.env.ATEND_FUSO || 'America/Sao_Paulo',
  // WhatsApp Cloud API (Meta). O token e o segredo do app ficam por empresa, no cadastro do número.
  whatsapp: {
    graph: (process.env.ATEND_GRAPH_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
    versao: process.env.ATEND_GRAPH_VERSAO || 'v23.0',
    timeoutMs: Number(process.env.ATEND_GRAPH_TIMEOUT_MS) || 20_000,
  },
  // Claude API: a camada de IA da atendente. Sem chave, a atendente roda só com as regras e a base de conhecimento.
  ia: {
    chave: process.env.ATEND_IA_CHAVE || process.env.ANTHROPIC_API_KEY || null,
    modelo: process.env.ATEND_IA_MODELO || 'claude-opus-5-5',
    // low | medium | high | xhigh | max. Atendimento é conversa curta: 'low' responde rápido e gasta menos.
    esforco: process.env.ATEND_IA_ESFORCO || 'low',
    maxTokens: Number(process.env.ATEND_IA_MAX_TOKENS) || 2048,
    // Quantas idas e voltas de ferramenta a IA pode fazer para responder uma mensagem.
    maxPassos: Number(process.env.ATEND_IA_MAX_PASSOS) || 6,
    timeoutMs: Number(process.env.ATEND_IA_TIMEOUT_MS) || 60_000,
    baseUrl: process.env.ATEND_IA_BASE_URL || null,
  },
  admin: {
    nome: process.env.ATEND_ADMIN_NOME || 'Master',
    email: process.env.ATEND_ADMIN_EMAIL || 'master@atendimento.com.br',
    senha: process.env.ATEND_ADMIN_SENHA || 'master123',
  },
};
