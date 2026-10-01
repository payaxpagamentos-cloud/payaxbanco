'use strict';

/* Popula o banco com dados de demonstração (clientes, contas, PIX, movimentos e empréstimos). */
const config = require('./config');
const { abrir } = require('./db');
const { popularDemo } = require('./lib/demo');

const db = abrir();
if (db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n > 0) {
  console.log('[PAY AX] O banco já possui clientes; seed ignorado.');
  process.exit(0);
}

popularDemo(db);

console.log('[PAY AX] Dados de demonstração criados.');
console.log(`  admin:    ${config.admin.email} / ${config.admin.senha}`);
console.log('  gerente:  gerente@payax.com.br / payax2026');
console.log('  operador: operador@payax.com.br / payax2026');
console.log('Internet Banking (/ib/): CPF 529.982.247-25 / Cliente2026 · CNPJ 11.222.333/0001-81 / Empresa2026 · senha de transação 246810');
