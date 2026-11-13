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
  // Em produção, atrás do Nginx/Apache: 127.0.0.1 (o instalador põe). Vazio escuta em todas as interfaces (Docker).
  host: process.env.ATEND_HOST || undefined,
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
  // Inteligência da ZOE (API de IA): a camada de IA da atendente. Sem chave, a atendente roda só com as regras e a base de conhecimento.
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
  // Transcrição dos áudios do cliente com o whisper.cpp, na própria máquina: não custa nada por
  // áudio, só CPU. Dois jeitos de rodar:
  //   - servidor (recomendado): o whisper-server fica no ar com o modelo carregado, e cada áudio
  //     leva uns 3 s. Basta ATEND_WHISPER_URL=http://127.0.0.1:8178.
  //   - local: o whisper-cli é chamado a cada áudio e recarrega o modelo toda vez (~1,5 s a mais).
  //     Basta ATEND_WHISPER_BIN e ATEND_WHISPER_MODELO apontarem para os arquivos.
  // Sem nenhum dos dois, fica desligada e a ZOE pede para o cliente escrever.
  // ATEND_TRANSCRICAO=desligada desliga de propósito (máquina apertada, por exemplo).
  transcricao: {
    modo: process.env.ATEND_TRANSCRICAO || 'auto',
    url: (process.env.ATEND_WHISPER_URL || '').replace(/\/+$/, '') || null,
    bin: process.env.ATEND_WHISPER_BIN || null,
    modelo: process.env.ATEND_WHISPER_MODELO || null,
    ffmpeg: process.env.ATEND_FFMPEG_BIN || 'ffmpeg',
    ffprobe: process.env.ATEND_FFPROBE_BIN || 'ffprobe',
    idioma: process.env.ATEND_WHISPER_IDIOMA || 'pt',
    // Vocabulário do assunto, passado ao whisper como prompt inicial. Medido aqui num áudio de
    // telefone (8 kHz): sem ele "quero falar com um atendente" saiu "com uma pendeinte"; com ele,
    // "atendente". Não faz milagre, mas puxa as palavras que mais importam para as regras.
    prompt: process.env.ATEND_WHISPER_PROMPT ?? 'Atendimento de provedor de internet. Atendente, boleto, segunda via, fatura, '
      + 'roteador, reiniciei o roteador, internet, cancelar, suporte, financeiro, desbloqueio, CPF, Wi-Fi, fibra.',
    threads: Number(process.env.ATEND_WHISPER_THREADS) || 4,
    // Quantos áudios ao mesmo tempo. Um por vez não trava a máquina quando chega uma rajada.
    simultaneos: Number(process.env.ATEND_WHISPER_SIMULTANEOS) || 1,
    // Áudio mais longo que isso não é transcrito: a ZOE pede um resumo por escrito.
    maxSegundos: Number(process.env.ATEND_WHISPER_MAX_SEGUNDOS) || 180,
    timeoutMs: Number(process.env.ATEND_WHISPER_TIMEOUT_MS) || 60_000,
  },
  // O dólar do dia vem da PTAX do Banco Central: pública, gratuita, sem chave.
  // Telefone do painel (WebRTC): o endereço wss:// do Asterisk e o domínio SIP. Sem WSS, fica desligado.
  webrtc: (() => {
    const wss = String(process.env.ATEND_WEBRTC_WSS || process.env.PABX_WEBRTC_WSS || '').trim();
    let url = null;
    try { url = wss ? new URL(wss) : null; } catch { url = null; }
    if (wss && (!url || url.protocol !== 'wss:')) console.warn('[ZOE] ATEND_WEBRTC_WSS deve começar com wss://; o telefone do painel ficará desligado.');
    const ok = url && url.protocol === 'wss:';
    return {
      wss: ok ? url.toString() : null,
      origem: ok ? `wss://${url.host}` : null,
      dominio: process.env.ATEND_SIP_DOMINIO || process.env.PABX_SIP_DOMINIO || (ok ? url.hostname : null),
      stun: String(process.env.ATEND_STUN ?? process.env.PABX_STUN ?? 'stun:stun.l.google.com:19302').split(',').map((x) => x.trim()).filter(Boolean),
    };
  })(),
  ptax: {
    url: (process.env.ATEND_PTAX_URL || 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata').replace(/\/+$/, ''),
    timeoutMs: Number(process.env.ATEND_PTAX_TIMEOUT_MS) || 15_000,
  },
  admin: {
    nome: process.env.ATEND_ADMIN_NOME || 'Master',
    email: process.env.ATEND_ADMIN_EMAIL || 'master@atendimento.com.br',
    senha: process.env.ATEND_ADMIN_SENHA || 'master123',
  },
};
