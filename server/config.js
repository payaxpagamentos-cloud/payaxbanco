'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.BPO_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.BPO_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[Ativa BPO] BPO_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['BPO_SECRET', 'BPO_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[Ativa BPO] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.BPO_SECRET.length < 32) throw new Error('[Ativa BPO] BPO_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.BPO_ADMIN_SENHA.length < 12) throw new Error('[Ativa BPO] BPO_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o sistema é publicado: '' (raiz do domínio) ou um caminho, como '/bpo'.
const caminho = (v) => String(v || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');
const basePath = caminho(process.env.BPO_BASE_PATH);
// Endereço do Portal do Cliente (ex.: '/bpo-cliente'). Padrão: '/portal' dentro do sistema.
const portalPath = caminho(process.env.BPO_PORTAL_PATH) || `${basePath}/portal`;

const dbFile = process.env.BPO_DB || path.join(__dirname, '..', 'data', 'bpo.db');

module.exports = {
  producao,
  basePath,
  portalPath,
  port: Number(process.env.PORT) || 3100,
  dbFile,
  secret,
  tokenTtlSeconds: 8 * 60 * 60,
  trustProxy: process.env.BPO_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.BPO_LIMITE_LOGIN) || 10,
  // Tolerância, em dias, entre a data do extrato e a do lançamento para sugerir conciliação.
  toleranciaConciliacaoDias: Number(process.env.BPO_TOLERANCIA_DIAS) || 3,
  // Arquivos enviados (notas, boletos, comprovantes) e cópias de segurança do banco.
  arquivosDir: process.env.BPO_ARQUIVOS || path.join(path.dirname(dbFile), 'arquivos'),
  backupDir: process.env.BPO_BACKUPS || path.join(path.dirname(dbFile), 'backups'),
  backupIntervaloHoras: Number(process.env.BPO_BACKUP_HORAS) || 24,
  backupManter: Number(process.env.BPO_BACKUP_MANTER) || 30,
  tamanhoMaximoArquivo: (Number(process.env.BPO_ARQUIVO_MAX_MB) || 10) * 1024 * 1024,
  tokenPortalTtlSeconds: 2 * 60 * 60,
  // Endereço público usado nos links dos e-mails (ex.: http://179.199.151.187 ou https://sistema.ativabpo.com.br).
  urlPublica: String(process.env.BPO_URL_PUBLICA || '').replace(/\/+$/, ''),
  // E-mail (SMTP). Sem BPO_SMTP_HOST, o envio fica desligado. BPO_SMTP_MODO=teste guarda as mensagens em memória.
  smtp: {
    host: process.env.BPO_SMTP_HOST || '',
    porta: Number(process.env.BPO_SMTP_PORTA) || 587,
    seguro: process.env.BPO_SMTP_SEGURO === '1' || Number(process.env.BPO_SMTP_PORTA) === 465,
    usuario: process.env.BPO_SMTP_USUARIO || '',
    senha: process.env.BPO_SMTP_SENHA || '',
    remetente: process.env.BPO_EMAIL_REMETENTE || 'Ativa BPO Financeiro <nao-responda@ativabpo.com.br>',
    modo: process.env.BPO_SMTP_MODO || '',
  },
  admin: {
    nome: process.env.BPO_ADMIN_NOME || 'Administrador BPO',
    email: process.env.BPO_ADMIN_EMAIL || 'admin@ativabpo.com.br',
    senha: process.env.BPO_ADMIN_SENHA || 'admin123',
  },
};
