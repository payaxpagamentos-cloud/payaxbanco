'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const producao = process.env.NODE_ENV === 'production';
const teste = process.env.NODE_ENV === 'test';

const secret = process.env.PAYAX_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PAYAX_SECRET && !teste) {
  console.warn('[PayAx] PAYAX_SECRET não definido: usando segredo temporário (as sessões expiram ao reiniciar).');
}

// Em produção, recusa iniciar sem os segredos — o sistema movimenta dinheiro de terceiros.
if (producao) {
  const faltando = ['PAYAX_SECRET', 'PAYAX_ADMIN_SENHA', 'PAYAX_CHAVE_CREDENCIAIS'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[PayAx] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.PAYAX_SECRET.length < 32) throw new Error('[PayAx] PAYAX_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.PAYAX_ADMIN_SENHA.length < 12) throw new Error('[PayAx] PAYAX_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
  if (!/^[0-9a-f]{64}$/i.test(process.env.PAYAX_CHAVE_CREDENCIAIS)) throw new Error('[PayAx] PAYAX_CHAVE_CREDENCIAIS deve ter 64 caracteres hexadecimais (32 bytes).');
}

// Cifra as credenciais do banco e dos IXC guardadas no banco de dados (AES-256-GCM). Fora de produção, deriva do segredo.
const chaveCredenciais = process.env.PAYAX_CHAVE_CREDENCIAIS
  ? Buffer.from(process.env.PAYAX_CHAVE_CREDENCIAIS, 'hex')
  : crypto.createHash('sha256').update(`credenciais:${secret}`).digest();

const caminho = (v, padrao) => String(v ?? padrao).replace(/\/+$/, '').replace(/^(?=[^/])/, '/');
const basePath = String(process.env.PAYAX_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');
const dados = process.env.PAYAX_DADOS || path.join(__dirname, '..', 'data');

module.exports = {
  producao,
  teste,
  // Backoffice PayAx (nossa área) e Internet Bank do cliente final, em endereços diferentes.
  basePath,
  clientePath: process.env.PAYAX_CLIENTE_PATH ? caminho(process.env.PAYAX_CLIENTE_PATH) : `${basePath}/cliente`,
  port: Number(process.env.PORT) || 3600,
  dbFile: process.env.PAYAX_DB || path.join(dados, 'payax.db'),
  // Comprovantes, remessas e retornos: fora da pasta pública, com nome aleatório.
  arquivos: process.env.PAYAX_ARQUIVOS || path.join(dados, 'arquivos'),
  arquivoMaxBytes: (Number(process.env.PAYAX_ARQUIVO_MAX_MB) || 10) * 1024 * 1024,
  secret,
  chaveCredenciais,
  tokenTtlSeconds: Number(process.env.PAYAX_SESSAO_HORAS || 8) * 3600,
  trustProxy: process.env.PAYAX_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.PAYAX_LIMITE_LOGIN) || 10,
  fusoPadrao: process.env.PAYAX_FUSO || 'America/Sao_Paulo',
  urlPublica: process.env.PAYAX_URL_PUBLICA || '',

  banco: {
    // 'simulador' registra os títulos localmente (desenvolvimento e homologação interna);
    // 'bradesco' fala com a API de Cobrança Registrada / Boleto Híbrido do Bradesco.
    modo: process.env.PAYAX_BANCO_MODO || (producao ? 'bradesco' : 'simulador'),
    ambiente: process.env.PAYAX_BANCO_AMBIENTE || 'homologacao',
    timeoutMs: Number(process.env.PAYAX_BANCO_TIMEOUT_MS) || 20_000,
  },
  // Consulta de CEP e CNPJ para preencher os cadastros sozinho.
  dados: {
    // 'publica' (ViaCEP / BrasilAPI, sem custo) ou 'apibrasil' (consome crédito da conta contratada).
    // O CEP é consultado em toda emissão de boleto; o CNPJ, só ao cadastrar. Daí os padrões diferentes.
    cepFonte: process.env.PAYAX_CEP_FONTE || 'publica',
    cnpjFonte: process.env.PAYAX_CNPJ_FONTE || 'apibrasil',
    timeoutMs: Number(process.env.PAYAX_DADOS_TIMEOUT_MS) || 8000,
    cacheCepDias: Number(process.env.PAYAX_CACHE_CEP_DIAS) || 180,
    cacheCnpjDias: Number(process.env.PAYAX_CACHE_CNPJ_DIAS) || 30,
    // Endereços das fontes, reunidos aqui para apontar a outro provedor sem mexer no resto.
    urlApiBrasil: process.env.PAYAX_APIBRASIL_URL || 'https://gateway.apibrasil.io/api/v2/dados',
    urlViaCep: process.env.PAYAX_VIACEP_URL || 'https://viacep.com.br/ws',
    urlBrasilApi: process.env.PAYAX_BRASILAPI_URL || 'https://brasilapi.com.br/api',
  },
  ixc: {
    timeoutMs: Number(process.env.PAYAX_IXC_TIMEOUT_MS) || 15_000,
    // Permite apontar o IXC para endereços da rede interna (evita SSRF quando desligado).
    redeInterna: process.env.PAYAX_IXC_REDE_INTERNA === '1',
  },
  // Rotinas automáticas (liberação de saldo, repasses, sincronismo e cobrança de vencidos).
  rotinas: process.env.PAYAX_ROTINAS !== '0' && !teste,
  rotinaIntervaloMin: Number(process.env.PAYAX_ROTINA_MIN) || 15,

  admin: {
    nome: process.env.PAYAX_ADMIN_NOME || 'Administrador',
    email: process.env.PAYAX_ADMIN_EMAIL || 'admin@payax.local',
    senha: process.env.PAYAX_ADMIN_SENHA || 'admin12345',
  },
};
