'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.PAYAX_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PAYAX_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[PAY AX] PAYAX_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

// Segredo extra misturado às senhas numéricas do Internet Banking antes do hash. Precisa ser fixo:
// trocá-lo invalida todas as senhas de clientes. Guarde-o fora do banco de dados.
const pepper = process.env.PAYAX_PEPPER || 'payax-pepper-desenvolvimento';
if (!process.env.PAYAX_PEPPER && process.env.NODE_ENV !== 'test') {
  console.warn('[PAY AX] PAYAX_PEPPER não definido: usando valor de desenvolvimento (defina em produção).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou valores de exemplo.
if (producao) {
  const faltando = ['PAYAX_SECRET', 'PAYAX_PEPPER', 'PAYAX_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[PAY AX] Produção sem configuração obrigatória: ${faltando.join(', ')}. Veja docs/PRODUCAO.md.`);
  if (process.env.PAYAX_SECRET.length < 32) throw new Error('[PAY AX] PAYAX_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.PAYAX_ADMIN_SENHA.length < 12) throw new Error('[PAY AX] PAYAX_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

module.exports = {
  producao,
  // Quantos proxies confiar para obter o IP real (ex.: 1 atrás do balanceador do Render/Railway).
  trustProxy: process.env.PAYAX_TRUST_PROXY ?? 'loopback',
  // Tentativas de login por IP por minuto (equipe e clientes).
  limiteLoginPorMinuto: Number(process.env.PAYAX_LIMITE_LOGIN) || 10,
  pepper,
  port: Number(process.env.PORT) || 3000,
  dbFile: process.env.PAYAX_DB || path.join(__dirname, '..', 'data', 'banqueiro.db'),
  secret,
  tokenTtlSeconds: 8 * 60 * 60,
  tokenClienteTtlSeconds: 30 * 60,
  agenciaPadrao: process.env.PAYAX_AGENCIA || '0001',
  // Deslocamento usado para agrupar dados por dia no fuso local (datas são gravadas em UTC).
  fusoSqlite: process.env.PAYAX_FUSO || '-3 hours',
  // Operações acima deste valor exigem perfil gerente ou admin.
  // Limite diário máximo que o cliente pode escolher sozinho no Internet Banking (acima disso, com o gerente).
  limiteDiarioMaximoCentavos: Number(process.env.PAYAX_LIMITE_DIARIO_MAXIMO) || 5_000_000,
  limiteOperadorCentavos: Number(process.env.PAYAX_LIMITE_OPERADOR) || 5_000_000,
  // Integração com a conta PJ da PAY AX no Bradesco (conta única; o Banqueiro controla o saldo de cada cliente).
  bradesco: {
    modo: process.env.BRADESCO_MODO || 'simulador', // simulador | sandbox | producao
    // URLs, credenciais e certificado vêm do contrato/portal Bradesco Developers. Nunca grave-os no código.
    tokenUrl: process.env.BRADESCO_TOKEN_URL || '',
    pixBaseUrl: process.env.BRADESCO_PIX_BASE_URL || '',
    clientId: process.env.BRADESCO_CLIENT_ID || '',
    clientSecret: process.env.BRADESCO_CLIENT_SECRET || '',
    certificado: process.env.BRADESCO_CERT_PFX || '', // caminho do e-CNPJ A1 (.pfx)
    senhaCertificado: process.env.BRADESCO_CERT_SENHA || '',
    chavePix: process.env.BRADESCO_CHAVE_PIX || '00000000000191', // chave PIX da conta PAY AX
    nomeRecebedor: process.env.BRADESCO_NOME_RECEBEDOR || 'PAY AX',
    cidadeRecebedor: process.env.BRADESCO_CIDADE_RECEBEDOR || 'SAO PAULO',
    webhookToken: process.env.BRADESCO_WEBHOOK_TOKEN || '',
    expiracaoCobrancaSegundos: Number(process.env.BRADESCO_EXPIRACAO_COBRANCA) || 3600,
  },
  admin: {
    nome: process.env.PAYAX_ADMIN_NOME || 'Administrador PAY AX',
    email: process.env.PAYAX_ADMIN_EMAIL || 'admin@payax.com.br',
    senha: process.env.PAYAX_ADMIN_SENHA || 'admin123',
  },
};
