'use strict';

/*
 * Mudanças de situação que podem precisar de análise da Ouvidoria: bloqueio, desbloqueio e encerramento
 * de contas, bloqueio e reativação de clientes, acesso ao Internet Banking e exclusão de clientes.
 * As rotas e a Ouvidoria (ao aprovar uma solicitação) usam as mesmas funções.
 */

const { ErroNegocio, naoEncontrado } = require('./erros');
const { buscarConta } = require('./conta');
const { registrar } = require('./auditoria');

const STATUS_CONTA = ['ativa', 'bloqueada', 'encerrada'];
const STATUS_CLIENTE = ['ativo', 'inativo', 'bloqueado'];

/** Ação correspondente a cada mudança (chave usada nas regras de análise da Ouvidoria). */
const acaoConta = (status) => ({ encerrada: 'encerrar_conta', bloqueada: 'bloquear_conta', ativa: 'desbloquear_conta' })[status];
const acaoCliente = (status) => (status === 'ativo' ? 'desbloquear_cliente' : 'bloquear_cliente');
const acaoIb = (status) => (status === 'ativo' ? 'desbloquear_ib' : 'bloquear_ib');

function validarStatusConta(db, conta, status) {
  if (!STATUS_CONTA.includes(status)) throw new ErroNegocio('Status inválido.', 422);
  if (conta.status === 'encerrada') throw new ErroNegocio('Conta encerrada não pode ser reaberta.', 409);
  if (conta.status === status) throw new ErroNegocio(`A conta já está ${status}.`, 409);
  if (status === 'encerrada') {
    if (conta.saldo_centavos !== 0) throw new ErroNegocio('Zere o saldo antes de encerrar a conta.', 409);
    if (db.prepare("SELECT 1 FROM emprestimos WHERE conta_id = ? AND status = 'ativo'").get(conta.id)) {
      throw new ErroNegocio('Conta possui empréstimo ativo.', 409);
    }
  }
}

function alterarStatusConta(db, req, contaId, status, detalhes = {}) {
  const conta = buscarConta(db, contaId);
  validarStatusConta(db, conta, status);
  if (status === 'encerrada') db.prepare('DELETE FROM chaves_pix WHERE conta_id = ?').run(conta.id);
  db.prepare(`UPDATE contas SET status = ?, encerrada_em = CASE WHEN ? = 'encerrada' THEN datetime('now') END WHERE id = ?`)
    .run(status, status, conta.id);
  registrar(db, req, `status_${status}`, 'conta', conta.id, { de: conta.status, ...detalhes });
  return buscarConta(db, conta.id);
}

function buscarCliente(db, clienteId) {
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
  if (!c) throw naoEncontrado('Cliente');
  return c;
}

function alterarStatusCliente(db, req, clienteId, status, detalhes = {}) {
  const c = buscarCliente(db, clienteId);
  if (!STATUS_CLIENTE.includes(status)) throw new ErroNegocio('Status inválido.', 422);
  if (c.status === status) return c;
  db.prepare("UPDATE clientes SET status = ?, atualizado_em = datetime('now') WHERE id = ?").run(status, c.id);
  registrar(db, req, 'atualizar', 'cliente', c.id, { status, de: c.status, ...detalhes });
  return buscarCliente(db, c.id);
}

function alterarStatusIb(db, req, clienteId, status, detalhes = {}) {
  const a = db.prepare('SELECT * FROM acessos_cliente WHERE cliente_id = ?').get(clienteId);
  if (!a) throw naoEncontrado('Acesso ao Internet Banking');
  if (!['ativo', 'bloqueado'].includes(status)) throw new ErroNegocio('Status inválido.', 422);
  db.prepare('UPDATE acessos_cliente SET status = ?, tentativas = 0, tentativas_pin = 0, bloqueado_ate = NULL WHERE cliente_id = ?').run(status, clienteId);
  registrar(db, req, 'ib_atualizar', 'cliente', clienteId, { status, ...detalhes });
}

function validarExclusaoCliente(db, c) {
  if (db.prepare('SELECT 1 FROM contas WHERE cliente_id = ?').get(c.id) || db.prepare('SELECT 1 FROM acessos_cliente WHERE cliente_id = ?').get(c.id)) {
    throw new ErroNegocio('Cliente possui contas ou acesso ao Internet Banking. Inative-o em vez de excluir.', 409);
  }
}

function excluirCliente(db, req, clienteId, detalhes = {}) {
  const c = buscarCliente(db, clienteId);
  validarExclusaoCliente(db, c);
  db.prepare('DELETE FROM clientes WHERE id = ?').run(c.id);
  registrar(db, req, 'excluir', 'cliente', c.id, { nome: c.nome, ...detalhes });
}

module.exports = {
  acaoConta, acaoCliente, acaoIb, validarStatusConta, alterarStatusConta, alterarStatusCliente, alterarStatusIb,
  validarExclusaoCliente, excluirCliente, buscarCliente,
};
