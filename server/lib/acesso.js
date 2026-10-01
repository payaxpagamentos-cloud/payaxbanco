'use strict';

const crypto = require('node:crypto');
const { senhaNumericaValida } = require('./teclado');
const { hashNumerica } = require('./senha');

/** Senha provisória de 6 números (digitada no teclado virtual do Internet Banking). */
function senhaProvisoria() {
  for (;;) {
    const s = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (senhaNumericaValida(s)) return s;
  }
}

/** Cria o acesso do cliente ao Internet Banking e devolve a senha provisória (mostrada uma única vez). */
function habilitarAcesso(db, clienteId) {
  const senha = senhaProvisoria();
  db.prepare('INSERT INTO acessos_cliente (cliente_id, senha_hash) VALUES (?, ?)').run(clienteId, hashNumerica(senha));
  return senha;
}

module.exports = { senhaProvisoria, habilitarAcesso };
