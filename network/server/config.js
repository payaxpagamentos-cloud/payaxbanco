'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const producao = process.env.NODE_ENV === 'production';
const teste = process.env.NODE_ENV === 'test';

const secret = process.env.NETWORK_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.NETWORK_SECRET && !teste) {
  console.warn('[Network] NETWORK_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['NETWORK_SECRET', 'NETWORK_ADMIN_SENHA', 'NETWORK_CHAVE_CREDENCIAIS'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[Network] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.NETWORK_SECRET.length < 32) throw new Error('[Network] NETWORK_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.NETWORK_ADMIN_SENHA.length < 12) throw new Error('[Network] NETWORK_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
  if (!/^[0-9a-f]{64}$/i.test(process.env.NETWORK_CHAVE_CREDENCIAIS)) throw new Error('[Network] NETWORK_CHAVE_CREDENCIAIS deve ter 64 caracteres hexadecimais (32 bytes).');
}

// Chave que cifra as credenciais das integrações guardadas no banco (AES-256-GCM). Sem ela (fora de produção), deriva do segredo.
const chaveCredenciais = process.env.NETWORK_CHAVE_CREDENCIAIS
  ? Buffer.from(process.env.NETWORK_CHAVE_CREDENCIAIS, 'hex')
  : crypto.createHash('sha256').update(`credenciais:${secret}`).digest();

const basePath = String(process.env.NETWORK_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');
const dados = process.env.NETWORK_DADOS || path.join(__dirname, '..', 'data');
const lat = Number(process.env.NETWORK_MAPA_LAT);
const lng = Number(process.env.NETWORK_MAPA_LNG);

// O conector do ZOE Atende fica pronto, porém DESLIGADO: o custo do WhatsApp vai para outro
// Manager, não para este. Quando o destino certo estiver definido, basta NETWORK_CUSTO_WHATSAPP=1
// (ou apontar o conector para lá) — nada precisa ser reescrito.
const custoWhatsapp = process.env.NETWORK_CUSTO_WHATSAPP === '1';

module.exports = {
  producao,
  custoWhatsapp,
  teste,
  basePath,
  port: Number(process.env.PORT) || 3500,
  dbFile: process.env.NETWORK_DB || path.join(dados, 'network.db'),
  // Comprovantes, fotos, documentos e evidências: fora da pasta pública, com nome aleatório.
  arquivos: process.env.NETWORK_ARQUIVOS || path.join(dados, 'arquivos'),
  arquivoMaxBytes: (Number(process.env.NETWORK_ARQUIVO_MAX_MB) || 10) * 1024 * 1024,
  secret,
  chaveCredenciais,
  tokenTtlSeconds: 12 * 60 * 60,
  // Validade dos links temporários de anexos (imagens e comprovantes abertos no navegador).
  linkAnexoSegundos: 300,
  trustProxy: process.env.NETWORK_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.NETWORK_LIMITE_LOGIN) || 10,
  fusoPadrao: process.env.NETWORK_FUSO || 'America/Sao_Paulo',
  // Os conectores podem acessar endereços da rede interna (ex.: rastreador no mesmo servidor em 127.0.0.1)?
  // Desligado por padrão para evitar que uma URL configurada alcance serviços internos (SSRF).
  conectorRedeInterna: process.env.NETWORK_CONECTOR_REDE_INTERNA === '1',
  conectorTimeoutMs: Number(process.env.NETWORK_CONECTOR_TIMEOUT_MS) || 10_000,
  // Liga as coletas periódicas (rastreador, Downdetector). Nos testes, as coletas são chamadas diretamente.
  coletasAutomaticas: process.env.NETWORK_COLETAS !== '0' && !teste,
  mapa: {
    // Camada de imagens do mapa (Leaflet). Use um provedor licenciado para o volume de uso da operação.
    tiles: process.env.NETWORK_MAPA_TILES || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    atribuicao: process.env.NETWORK_MAPA_ATRIBUICAO || 'Mapa &copy; Esri, HERE, Garmin, colaboradores do OpenStreetMap',
    centro: [Number.isFinite(lat) ? lat : -24.0058, Number.isFinite(lng) ? lng : -46.4028],
  },
  admin: {
    organizacao: process.env.NETWORK_ORGANIZACAO || 'Minha operação',
    nome: process.env.NETWORK_ADMIN_NOME || 'Administrador',
    email: process.env.NETWORK_ADMIN_EMAIL || 'admin@managernetwork.local',
    senha: process.env.NETWORK_ADMIN_SENHA || 'admin12345',
  },
};
