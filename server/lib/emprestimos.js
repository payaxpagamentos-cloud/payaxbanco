'use strict';

const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { registrar } = require('./auditoria');
const { buscarConta, exigirContaOperavel, novoGrupo, lancar } = require('./conta');
const { canalDe } = require('./movimentos');

/** Paga a próxima parcela em aberto debitando a conta do empréstimo (agência ou Internet Banking). */
function pagarParcela(db, req, emprestimoId, numero) {
  const e = db.prepare('SELECT * FROM emprestimos WHERE id = ?').get(emprestimoId);
  if (!e) throw naoEncontrado('Empréstimo');
  if (req.cliente && e.cliente_id !== req.cliente.id) throw naoEncontrado('Empréstimo');
  if (e.status !== 'ativo') throw new ErroNegocio(`Empréstimo ${e.status}.`, 409);
  const parcelas = db.prepare('SELECT * FROM parcelas WHERE emprestimo_id = ? ORDER BY numero').all(e.id);
  const parcela = parcelas.find((p) => p.numero === Number(numero));
  if (!parcela) throw naoEncontrado('Parcela');
  if (parcela.status === 'paga') throw new ErroNegocio('Parcela já paga.', 409);
  const proxima = parcelas.find((p) => p.status === 'aberta');
  if (proxima.numero !== parcela.numero) throw new ErroNegocio(`Pague primeiro a parcela ${proxima.numero}.`, 409);
  const conta = buscarConta(db, e.conta_id);
  exigirContaOperavel(conta);
  return transacao(db, () => {
    const t = lancar(db, {
      contaId: conta.id, tipo: 'emprestimo_parcela', valor: -parcela.valor_centavos, grupo: novoGrupo(),
      descricao: `Parcela ${parcela.numero}/${e.num_parcelas} empréstimo #${e.id}`, usuarioId: req.usuario?.id ?? null, canal: canalDe(req),
    });
    db.prepare("UPDATE parcelas SET status = 'paga', paga_em = datetime('now') WHERE id = ?").run(parcela.id);
    const { abertas } = db.prepare("SELECT COUNT(*) AS abertas FROM parcelas WHERE emprestimo_id = ? AND status = 'aberta'").get(e.id);
    if (abertas === 0) db.prepare("UPDATE emprestimos SET status = 'quitado' WHERE id = ?").run(e.id);
    registrar(db, req, 'pagar_parcela', 'emprestimo', e.id, { parcela: parcela.numero, valor_centavos: parcela.valor_centavos });
    return { transacao_id: t.id, valor_centavos: parcela.valor_centavos, saldo_centavos: t.saldo_apos_centavos };
  });
}

module.exports = { pagarParcela };
