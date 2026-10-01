'use strict';

const { Router } = require('express');
const { permitir } = require('../auth');
const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const v = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');
const { buscarConta, exigirContaOperavel, novoGrupo, lancar } = require('../lib/conta');
const { simular } = require('../lib/financeiro');

function lerProposta(body) {
  const valor = v.valorCentavos(body?.valor_centavos);
  const taxa = Number(body?.taxa_mensal);
  const parcelas = Number(body?.num_parcelas);
  v.exigir(Number.isFinite(taxa) && taxa >= 0 && taxa <= 0.2, 'Taxa mensal deve estar entre 0% e 20%.');
  v.exigir(Number.isInteger(parcelas) && parcelas >= 1 && parcelas <= 120, 'Número de parcelas deve ser entre 1 e 120.');
  return { valor, taxa, parcelas };
}

module.exports = (db) => {
  const r = Router();

  const detalhar = (id) => {
    const e = db.prepare(`SELECT e.*, cl.nome AS cliente_nome, c.agencia, c.numero, c.digito
      FROM emprestimos e JOIN clientes cl ON cl.id = e.cliente_id JOIN contas c ON c.id = e.conta_id WHERE e.id = ?`).get(id);
    if (!e) throw naoEncontrado('Empréstimo');
    e.parcelas = db.prepare('SELECT * FROM parcelas WHERE emprestimo_id = ? ORDER BY numero').all(e.id);
    e.saldo_devedor_centavos = e.parcelas.filter((p) => p.status === 'aberta').reduce((a, p) => a + p.valor_centavos, 0);
    return e;
  };

  r.get('/', (req, res) => {
    const filtros = [];
    const params = [];
    if (req.query.status) { filtros.push('e.status = ?'); params.push(req.query.status); }
    if (req.query.cliente_id) { filtros.push('e.cliente_id = ?'); params.push(req.query.cliente_id); }
    if (req.query.q) { filtros.push('cl.nome LIKE ?'); params.push(`%${req.query.q}%`); }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT e.*, cl.nome AS cliente_nome, c.numero || '-' || c.digito AS conta,
        (SELECT COUNT(*) FROM parcelas p WHERE p.emprestimo_id = e.id AND p.status = 'paga') AS parcelas_pagas,
        (SELECT COALESCE(SUM(valor_centavos),0) FROM parcelas p WHERE p.emprestimo_id = e.id AND p.status = 'aberta') AS saldo_devedor_centavos,
        (SELECT MIN(vencimento) FROM parcelas p WHERE p.emprestimo_id = e.id AND p.status = 'aberta') AS proximo_vencimento
      FROM emprestimos e JOIN clientes cl ON cl.id = e.cliente_id JOIN contas c ON c.id = e.conta_id
      ${where} ORDER BY e.criado_em DESC, e.id DESC LIMIT 500`).all(...params));
  });

  r.post('/simular', (req, res) => {
    const { valor, taxa, parcelas } = lerProposta(req.body);
    res.json(simular(valor, taxa, parcelas));
  });

  r.get('/:id', (req, res) => res.json(detalhar(req.params.id)));

  r.post('/', permitir('admin', 'gerente'), (req, res) => {
    const conta = buscarConta(db, req.body?.conta_id);
    exigirContaOperavel(conta);
    v.exigir(conta.tipo !== 'poupanca', 'Empréstimos não podem ser creditados em conta poupança.');
    const { valor, taxa, parcelas } = lerProposta(req.body);
    const sim = simular(valor, taxa, parcelas);
    const id = transacao(db, () => {
      const ins = db.prepare(`INSERT INTO emprestimos (conta_id, cliente_id, valor_centavos, taxa_mensal, num_parcelas, valor_parcela_centavos, usuario_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(conta.id, conta.cliente_id, valor, taxa, parcelas, sim.valor_parcela_centavos, req.usuario.id);
      const empId = Number(ins.lastInsertRowid);
      const insP = db.prepare('INSERT INTO parcelas (emprestimo_id, numero, vencimento, valor_centavos) VALUES (?, ?, ?, ?)');
      for (const p of sim.cronograma) insP.run(empId, p.numero, p.vencimento, p.valor_centavos);
      lancar(db, { contaId: conta.id, tipo: 'emprestimo_credito', valor, descricao: `Crédito empréstimo #${empId}`, grupo: novoGrupo(), usuarioId: req.usuario.id });
      registrar(db, req, 'contratar', 'emprestimo', empId, { conta_id: conta.id, valor_centavos: valor, taxa, parcelas });
      return empId;
    });
    res.status(201).json(detalhar(id));
  });

  // Parcelas são pagas pelo próprio cliente, no Internet Banking (débito autorizado com senha de transação).

  return r;
};
