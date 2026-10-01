'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.PAYAX_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PAYAX_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[PAY AX] PAYAX_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  dbFile: process.env.PAYAX_DB || path.join(__dirname, '..', 'data', 'banqueiro.db'),
  secret,
  tokenTtlSeconds: 8 * 60 * 60,
  agenciaPadrao: process.env.PAYAX_AGENCIA || '0001',
  // Deslocamento usado para agrupar dados por dia no fuso local (datas são gravadas em UTC).
  fusoSqlite: process.env.PAYAX_FUSO || '-3 hours',
  // Operações acima deste valor exigem perfil gerente ou admin.
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
