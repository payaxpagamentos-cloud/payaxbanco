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
  // Operações acima deste valor exigem perfil gerente ou admin.
  // Deslocamento usado para agrupar dados por dia no fuso local (datas são gravadas em UTC).
  fusoSqlite: process.env.PAYAX_FUSO || '-3 hours',
  limiteOperadorCentavos: Number(process.env.PAYAX_LIMITE_OPERADOR) || 5_000_000,
  admin: {
    nome: process.env.PAYAX_ADMIN_NOME || 'Administrador PAY AX',
    email: process.env.PAYAX_ADMIN_EMAIL || 'admin@payax.com.br',
    senha: process.env.PAYAX_ADMIN_SENHA || 'admin123',
  },
};
