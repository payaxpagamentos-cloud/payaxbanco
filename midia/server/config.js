'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.MIDIA_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.MIDIA_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[Vai Mídia] MIDIA_SECRET não definido: usando segredo temporário (sessões e TVs pareadas caem ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['MIDIA_SECRET', 'MIDIA_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[Vai Mídia] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.MIDIA_SECRET.length < 32) throw new Error('[Vai Mídia] MIDIA_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.MIDIA_ADMIN_SENHA.length < 12) throw new Error('[Vai Mídia] MIDIA_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o painel é publicado: '' (raiz do domínio) ou um caminho, como '/midia'.
const basePath = String(process.env.MIDIA_BASE_PATH ?? '/midia').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');

module.exports = {
  producao,
  basePath,
  // Servir o site institucional (pasta site/) na raiz e em <base>/site/. MIDIA_SITE=0 desliga.
  site: String(process.env.MIDIA_SITE ?? '1') !== '0',
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
  // Backup: cópia do banco a cada N horas, guardando as mais recentes. O espelho das mídias é opcional
  // (sem MIDIA_ESPELHO, os arquivos não são copiados — o painel e o diagnóstico avisam).
  backupDir: process.env.MIDIA_BACKUPS || path.join(__dirname, '..', 'data', 'backups'),
  backupIntervaloHoras: Number(process.env.MIDIA_BACKUP_HORAS) || 24,
  backupManter: Number(process.env.MIDIA_BACKUP_MANTER) || 30,
  espelho: process.env.MIDIA_ESPELHO || null,
  // Versão do player publicada aqui. A tela manda a dela na batida; o diagnóstico aponta quem ficou para trás
  // e o painel manda recarregar (sem ninguém precisar ir até o prédio).
  playerVersao: '1.1',
  // Tamanho máximo de um arquivo de mídia enviado ao painel.
  midiaMaxBytes: (Number(process.env.MIDIA_MAX_MB) || 200) * 1024 * 1024,
  // Envio de e-mails (avisos de tela fora do ar, fatura vencida e recuperação de senha).
  // Sem MIDIA_SMTP_HOST, fica desligado e o painel avisa. 'teste' guarda as mensagens em memória (testes).
  smtp: {
    modo: process.env.MIDIA_SMTP_MODO || (process.env.NODE_ENV === 'test' ? 'teste' : ''),
    host: process.env.MIDIA_SMTP_HOST || '',
    porta: Number(process.env.MIDIA_SMTP_PORTA) || 587,
    seguro: process.env.MIDIA_SMTP_SEGURO === '1',
    usuario: process.env.MIDIA_SMTP_USUARIO || '',
    senha: process.env.MIDIA_SMTP_SENHA || '',
    remetente: process.env.MIDIA_SMTP_DE || 'Vai Mídia <nao-responda@vaimidia.com.br>',
  },
  // Endereço público do painel, usado nos links dos e-mails.
  url: (process.env.MIDIA_URL || '').replace(/\/+$/, ''),
  /*
   * Caixa de entrada do CRM: o servidor de e-mail da própria plataforma.
   *
   * Com MIDIA_EMAIL_DOMINIOS preenchido (ex.: "vaimidia.com.br"), o sistema abre um servidor SMTP e passa
   * a RECEBER mensagens endereçadas a esses domínios — elas caem no CRM, ligadas ao lead de quem escreveu.
   * Sem isso, fica desligado e o painel avisa. O ENVIO continua pelo MIDIA_SMTP_* (ver README: um servidor
   * que manda sozinho, sem reputação, costuma cair na caixa de spam de quem recebe).
   */
  entrada: {
    dominios: String(process.env.MIDIA_EMAIL_DOMINIOS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    porta: Number(process.env.MIDIA_EMAIL_PORTA ?? 25),
    // Em que endereço ouvir. Vazio = todas as interfaces (é o normal para receber da internet).
    host: process.env.MIDIA_EMAIL_HOST || undefined,
    maxBytes: (Number(process.env.MIDIA_EMAIL_MAX_MB) || 10) * 1024 * 1024,
    // Onde ficam as mensagens originais (.eml), fora da pasta pública.
    pasta: process.env.MIDIA_EMAIL_PASTA || path.join(__dirname, '..', 'data', 'emails'),
  },
  // Assinatura DKIM do que sai (melhora muito a chance de não cair em spam). Chave privada em arquivo PEM.
  dkim: {
    dominio: process.env.MIDIA_DKIM_DOMINIO || '',
    seletor: process.env.MIDIA_DKIM_SELETOR || 'vaimidia',
    chaveArquivo: process.env.MIDIA_DKIM_CHAVE || '',
  },
  admin: {
    nome: process.env.MIDIA_ADMIN_NOME || 'Master',
    email: process.env.MIDIA_ADMIN_EMAIL || 'master@midia.com.br',
    senha: process.env.MIDIA_ADMIN_SENHA || 'master123',
  },
};
