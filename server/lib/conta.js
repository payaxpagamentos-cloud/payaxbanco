'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { ErroNegocio, naoEncontrado } = require('./erros');

/** Dígito verificador módulo 11 (pesos 2..9), com 10 → "X" e 11 → "0". */
function digitoVerificador(numero) {
  let soma = 0;
  let peso = 2;
  for (let i = numero.length - 1; i >= 0; i--) {
    soma += Number(numero[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const r = 11 - (soma % 11);
  if (r === 11) return '0';
  if (r === 10) return 'X';
  return String(r);
}

function proximoNumero(db, agencia = config.agenciaPadrao) {
  const { maior } = db.prepare('SELECT MAX(CAST(numero AS INTEGER)) AS maior FROM contas WHERE agencia = ?').get(agencia);
  const numero = String((maior || 100000) + 1).padStart(6, '0');
  return { agencia, numero, digito: digitoVerificador(numero) };
}

function buscarConta(db, id) {
  const conta = db.prepare(`
    SELECT c.*, cl.nome AS cliente_nome, cl.documento AS cliente_documento, cl.status AS cliente_status
    FROM contas c JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = ?`).get(id);
  if (!conta) throw naoEncontrado('Conta');
  return conta;
}

function exigirContaOperavel(conta) {
  if (conta.status !== 'ativa') throw new ErroNegocio(`A conta ${conta.numero}-${conta.digito} está ${conta.status}.`, 409);
  if (conta.cliente_status !== 'ativo') throw new ErroNegocio(`O titular da conta ${conta.numero}-${conta.digito} está ${conta.cliente_status}.`, 409);
}

const novoGrupo = () => crypto.randomUUID();

/**
 * Lança um movimento (crédito > 0, débito < 0) na conta, atualizando o saldo.
 * Deve ser chamado dentro de uma transação de banco.
 */
function lancar(db, { contaId, tipo, valor, descricao = null, contraparteId = null, grupo, usuarioId = null, ignorarLimite = false, canal = 'agencia' }) {
  const conta = db.prepare('SELECT id, saldo_centavos, limite_centavos, numero, digito FROM contas WHERE id = ?').get(contaId);
  const novoSaldo = conta.saldo_centavos + valor;
  if (valor < 0 && !ignorarLimite && novoSaldo < -conta.limite_centavos) {
    throw new ErroNegocio(`Saldo insuficiente na conta ${conta.numero}-${conta.digito}.`, 409);
  }
  db.prepare('UPDATE contas SET saldo_centavos = ? WHERE id = ?').run(novoSaldo, contaId);
  const r = db.prepare(`INSERT INTO transacoes
      (conta_id, tipo, valor_centavos, saldo_apos_centavos, descricao, contraparte_conta_id, grupo, usuario_id, canal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(contaId, tipo, valor, novoSaldo, descricao, contraparteId, grupo, usuarioId, canal);
  return { id: Number(r.lastInsertRowid), saldo_apos_centavos: novoSaldo };
}

function exigirAlcada(req, valor) {
  if (!req.usuario) return; // operações do próprio cliente seguem o limite diário do Internet Banking
  if (valor > config.limiteOperadorCentavos && req.usuario.perfil === 'operador') {
    throw new ErroNegocio('Valor acima da alçada do operador. Solicite a um gerente.', 403);
  }
}

module.exports = { digitoVerificador, proximoNumero, buscarConta, exigirContaOperavel, novoGrupo, lancar, exigirAlcada };
