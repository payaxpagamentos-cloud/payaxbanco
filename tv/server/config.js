'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.TV_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.TV_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[PLAY TECH VIP] TV_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes, fracos ou ainda com o valor de exemplo.
// (O .env.exemplo traz valores com "troque": subir com eles é o mesmo que não ter senha.)
const DE_EXEMPLO = /troque|exemplo|mude-?isto|changeme|senha123|admin123/i;
if (producao) {
  const faltando = ['TV_SECRET', 'TV_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[PLAY TECH VIP] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.TV_SECRET.length < 32) throw new Error('[PLAY TECH VIP] TV_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.TV_ADMIN_SENHA.length < 12) throw new Error('[PLAY TECH VIP] TV_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
  for (const k of ['TV_SECRET', 'TV_ADMIN_SENHA']) {
    if (DE_EXEMPLO.test(process.env[k])) {
      throw new Error(`[PLAY TECH VIP] ${k} ainda está com o valor de exemplo do .env. Troque antes de abrir ao público.`);
    }
  }
}

// Endereço em que a plataforma é publicada: '' (raiz do domínio) ou um caminho, como '/tv'.
const basePath = String(process.env.TV_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');
const dbFile = process.env.TV_DB || path.join(__dirname, '..', 'data', 'tv.db');

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3600,
  dbFile,
  secret,
  // Nome da plataforma nas telas, nos e-mails e no PIX.
  marca: process.env.TV_MARCA || 'PLAY TECH VIP',
  // Sessão do assinante dura mais que a da operação (a TV fica aberta na sala).
  tokenTtlSeconds: Number(process.env.TV_SESSAO_HORAS) * 3600 || 30 * 24 * 60 * 60,
  tokenOperacaoTtlSeconds: 8 * 60 * 60,
  trustProxy: process.env.TV_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.TV_LIMITE_LOGIN) || 10,
  fuso: process.env.TV_FUSO || 'America/Sao_Paulo',
  // Vídeos, artes e legendas enviados pelo painel. Ficam fora da pasta pública, com nome aleatório.
  // **Inclua esta pasta no backup** (o banco guarda só os registros).
  midiaDir: process.env.TV_MIDIA || path.join(path.dirname(dbFile), 'midia'),
  // Catálogo de filmes e séries (themoviedb.org): cartaz, banner, sinopse, elenco e classificação.
  // O token é gratuito e sai da conta do cliente; sem ele, a busca some do painel.
  tmdb: {
    token: process.env.TV_TMDB_TOKEN || '',
    idioma: process.env.TV_TMDB_IDIOMA || 'pt-BR',
  },
  // Conversão automática das versões menores (Full HD, HD e SD) a partir do arquivo enviado.
  ffmpeg: process.env.TV_FFMPEG || 'ffmpeg',
  conversao: {
    preset: process.env.TV_CONVERSAO_PRESET || 'veryfast',
    crf: Number(process.env.TV_CONVERSAO_CRF) || 23,
  },
  videoMaxBytes: (Number(process.env.TV_VIDEO_MAX_MB) || 8192) * 1024 * 1024,
  arteMaxBytes: (Number(process.env.TV_ARTE_MAX_MB) || 8) * 1024 * 1024,
  legendaMaxBytes: (Number(process.env.TV_LEGENDA_MAX_KB) || 512) * 1024,
  // Pedaço de cada envio do painel (o navegador fatia o arquivo): 8 MB por requisição.
  uploadParteMaxBytes: (Number(process.env.TV_UPLOAD_PARTE_MB) || 8) * 1024 * 1024,
  // Token de reprodução: vale por algumas horas e é assinado para o perfil e o aparelho.
  playTokenSegundos: Number(process.env.TV_PLAY_TTL) || 6 * 60 * 60,
  // Link assinado de cada segmento do canal ao vivo (curto: o player renova a cada lista).
  segmentoTokenSegundos: Number(process.env.TV_SEGMENTO_TTL) || 60 * 60,
  // Telas simultâneas: a sessão do player morre sem sinal de vida por este tempo.
  sessaoPlayerSegundos: Number(process.env.TV_SESSAO_PLAYER_S) || 120,
  // Transmissão (CDN) dos canais ao vivo: o servidor busca a lista HLS na origem e entrega os segmentos
  // pelo nosso endereço. Protege a origem, resolve CORS e deixa a política de segurança das páginas fechada em 'self'.
  relay: {
    ligado: process.env.TV_RELAY !== '0',
    timeoutMs: Number(process.env.TV_RELAY_TIMEOUT_MS) || 12_000,
    // Cache do manifesto em memória (segundos). Segmentos não são guardados: são repassados em fluxo.
    cacheListaMs: Number(process.env.TV_RELAY_CACHE_MS) || 2000,
    segmentoMaxBytes: (Number(process.env.TV_RELAY_SEGMENTO_MAX_MB) || 32) * 1024 * 1024,
    userAgent: process.env.TV_RELAY_USER_AGENT || 'PLAYTECHVIP/1.0',
  },
  // Canais marcados para tocar direto na origem (sem transmissão) precisam que o domínio da emissora
  // seja liberado na política de segurança das páginas. Lista separada por vírgula, ex.: 'cdn.emissora.com.br'.
  origensMidia: String(process.env.TV_ORIGENS_MIDIA || '').split(',').map((h) => h.trim()).filter(Boolean),
  // Cobrança: 'simulado' (testes: o assinante confirma o PIX na tela) ou 'manual'
  // (PIX na chave da plataforma, confirmado pela operação). A baixa automática exige um intermediador (PSP).
  pagamentos: process.env.TV_PAGAMENTOS || (producao ? 'manual' : 'simulado'),
  admin: {
    nome: process.env.TV_ADMIN_NOME || 'Operação PLAY TECH VIP',
    email: process.env.TV_ADMIN_EMAIL || 'admin@playtechvip.com.br',
    senha: process.env.TV_ADMIN_SENHA || 'admin123',
  },
};
