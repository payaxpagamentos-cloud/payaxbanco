'use strict';

const crypto = require('node:crypto');
const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { daEmpresa } = require('./acesso');
const v = require('./validacao');
const { somarMeses, hoje } = require('./datas');

const sinal = (tipo) => (tipo === 'receber' ? 1 : -1);

/** Situação para a tela: aberto vira "vencido" depois do vencimento. */
const situacao = (l, dia = hoje()) => (l.status === 'aberto' && l.vencimento < dia ? 'vencido' : l.status);

/** Valida os campos comuns e os vínculos com cadastros da própria empresa. */
function normalizar(db, empresaId, corpo, tipo) {
  const categoria = daEmpresa(db, 'categorias', v.id(corpo.categoria_id), empresaId, 'Categoria');
  v.exigir(categoria, 'Informe a categoria.');
  v.exigir(categoria.tipo === (tipo === 'receber' ? 'receita' : 'despesa'),
    tipo === 'receber' ? 'Conta a receber precisa de categoria de receita.' : 'Conta a pagar precisa de categoria de despesa.');
  daEmpresa(db, 'contatos', v.id(corpo.contato_id), empresaId, 'Contato');
  daEmpresa(db, 'centros_custo', v.id(corpo.centro_custo_id), empresaId, 'Centro de custo');
  daEmpresa(db, 'contas_bancarias', v.id(corpo.conta_bancaria_id), empresaId, 'Conta bancária');
  const descricao = v.texto(corpo.descricao, 200);
  v.exigir(descricao, 'Informe a descrição.');
  return {
    descricao,
    contato_id: v.id(corpo.contato_id),
    categoria_id: categoria.id,
    centro_custo_id: v.id(corpo.centro_custo_id),
    conta_bancaria_id: v.id(corpo.conta_bancaria_id),
    documento: v.texto(corpo.documento, 60),
    observacoes: v.texto(corpo.observacoes, 1000),
  };
}

/**
 * Cria a conta a pagar/receber. Com `parcelas` > 1, divide o valor (a diferença de centavos vai na
 * primeira parcela) e gera vencimentos mensais a partir do primeiro.
 */
function criar(db, req, empresaId, corpo) {
  const tipo = corpo.tipo;
  v.exigir(['pagar', 'receber'].includes(tipo), 'Tipo deve ser "pagar" ou "receber".');
  const base = normalizar(db, empresaId, corpo, tipo);
  const total = v.valorCentavos(corpo.valor_centavos);
  const vencimento = v.data(corpo.vencimento, 'o vencimento');
  const competencia = v.data(corpo.competencia || vencimento, 'a competência');
  const parcelas = Number(corpo.parcelas ?? 1);
  v.exigir(Number.isInteger(parcelas) && parcelas >= 1 && parcelas <= 120, 'Parcelas: de 1 a 120.');
  v.exigir(total >= parcelas, 'Valor menor que o número de parcelas.');

  const valorParcela = Math.floor(total / parcelas);
  const grupo = parcelas > 1 ? crypto.randomUUID() : null;
  const inserir = db.prepare(`INSERT INTO lancamentos (empresa_id, tipo, descricao, contato_id, categoria_id, centro_custo_id, conta_bancaria_id,
    valor_centavos, competencia, vencimento, documento, parcela, total_parcelas, grupo, observacoes, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return transacao(db, () => {
    const ids = [];
    for (let n = 1; n <= parcelas; n++) {
      const valor = n === 1 ? total - valorParcela * (parcelas - 1) : valorParcela;
      const r = inserir.run(empresaId, tipo, base.descricao, base.contato_id, base.categoria_id, base.centro_custo_id, base.conta_bancaria_id,
        valor, somarMeses(competencia, n - 1), somarMeses(vencimento, n - 1), base.documento, n, parcelas, grupo, base.observacoes, req.usuario.id);
      ids.push(Number(r.lastInsertRowid));
    }
    return ids;
  });
}

function buscar(db, empresaId, id) {
  const l = db.prepare('SELECT * FROM lancamentos WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!l) throw naoEncontrado('Lançamento');
  return l;
}

/** Edita um lançamento em aberto. Pago ou cancelado não muda (estorne a baixa antes). */
function editar(db, empresaId, id, corpo) {
  const l = buscar(db, empresaId, id);
  v.exigir(l.status === 'aberto', 'Só é possível editar lançamentos em aberto.');
  const base = normalizar(db, empresaId, { ...l, ...corpo }, l.tipo);
  const valor = v.valorCentavos(corpo.valor_centavos ?? l.valor_centavos);
  const vencimento = v.data(corpo.vencimento ?? l.vencimento, 'o vencimento');
  const competencia = v.data(corpo.competencia ?? l.competencia, 'a competência');
  db.prepare(`UPDATE lancamentos SET descricao = ?, contato_id = ?, categoria_id = ?, centro_custo_id = ?, conta_bancaria_id = ?,
    valor_centavos = ?, competencia = ?, vencimento = ?, documento = ?, observacoes = ? WHERE id = ?`)
    .run(base.descricao, base.contato_id, base.categoria_id, base.centro_custo_id, base.conta_bancaria_id, valor, competencia, vencimento,
      base.documento, base.observacoes, l.id);
  return buscar(db, empresaId, id);
}

/**
 * Baixa (pagamento ou recebimento): grava data, valor pago, juros e desconto e lança o movimento na
 * conta bancária. Valor pago = valor + juros - desconto. Retorna o id do movimento criado.
 */
function baixar(db, req, empresaId, id, corpo) {
  return transacao(db, () => {
    const l = buscar(db, empresaId, id);
    v.exigir(l.status === 'aberto', l.status === 'pago' ? 'Este lançamento já foi baixado.' : 'Lançamento cancelado.');
    const conta = daEmpresa(db, 'contas_bancarias', v.id(corpo.conta_bancaria_id ?? l.conta_bancaria_id), empresaId, 'Conta bancária');
    v.exigir(conta, 'Informe a conta bancária da baixa.');
    v.exigir(conta.ativo, 'Conta bancária inativa.');
    const data = v.data(corpo.data ?? hoje(), 'a data da baixa');
    const juros = v.valorCentavos(corpo.juros_centavos ?? 0, 'juros', { zero: true });
    const desconto = v.valorCentavos(corpo.desconto_centavos ?? 0, 'desconto', { zero: true });
    const pago = l.valor_centavos + juros - desconto;
    v.exigir(pago > 0, 'O desconto não pode ser maior ou igual ao valor.');
    db.prepare(`UPDATE lancamentos SET status = 'pago', pago_em = ?, valor_pago_centavos = ?, juros_centavos = ?, desconto_centavos = ?,
      conta_bancaria_id = ? WHERE id = ?`).run(data, pago, juros, desconto, conta.id, l.id);
    const r = db.prepare(`INSERT INTO movimentos (empresa_id, conta_bancaria_id, data, valor_centavos, descricao, origem, lancamento_id, usuario_id)
      VALUES (?, ?, ?, ?, ?, 'baixa', ?, ?)`).run(empresaId, conta.id, data, sinal(l.tipo) * pago, l.descricao, l.id, req.usuario.id);
    return Number(r.lastInsertRowid);
  });
}

/** Desfaz a baixa. Se o movimento já estava conciliado com o extrato, a linha do extrato volta a ficar pendente. */
function estornarBaixa(db, empresaId, id) {
  return transacao(db, () => {
    const l = buscar(db, empresaId, id);
    v.exigir(l.status === 'pago', 'Este lançamento não está baixado.');
    const mov = db.prepare('SELECT id FROM movimentos WHERE lancamento_id = ?').get(l.id);
    if (mov) {
      db.prepare("UPDATE extrato SET status = 'pendente', movimento_id = NULL, conciliado_por = NULL, conciliado_em = NULL WHERE movimento_id = ?").run(mov.id);
      db.prepare('DELETE FROM movimentos WHERE id = ?').run(mov.id);
    }
    db.prepare(`UPDATE lancamentos SET status = 'aberto', pago_em = NULL, valor_pago_centavos = NULL, juros_centavos = 0, desconto_centavos = 0
      WHERE id = ?`).run(l.id);
  });
}

function cancelar(db, empresaId, id) {
  const l = buscar(db, empresaId, id);
  if (l.status === 'pago') throw new ErroNegocio('Estorne a baixa antes de cancelar.', 422);
  v.exigir(l.status === 'aberto', 'Lançamento já cancelado.');
  db.prepare("UPDATE lancamentos SET status = 'cancelado' WHERE id = ?").run(l.id);
}

/** Transferência entre duas contas da mesma empresa: dois movimentos ligados pelo mesmo grupo. */
function transferir(db, req, empresaId, corpo) {
  const origem = daEmpresa(db, 'contas_bancarias', v.id(corpo.origem_id), empresaId, 'Conta de origem');
  const destino = daEmpresa(db, 'contas_bancarias', v.id(corpo.destino_id), empresaId, 'Conta de destino');
  v.exigir(origem && destino, 'Informe as contas de origem e destino.');
  v.exigir(origem.id !== destino.id, 'Origem e destino devem ser contas diferentes.');
  const valor = v.valorCentavos(corpo.valor_centavos);
  const data = v.data(corpo.data ?? hoje(), 'a data');
  const descricao = v.texto(corpo.descricao, 200) || `Transferência ${origem.descricao} → ${destino.descricao}`;
  const grupo = crypto.randomUUID();
  const ins = db.prepare(`INSERT INTO movimentos (empresa_id, conta_bancaria_id, data, valor_centavos, descricao, origem, grupo, usuario_id)
    VALUES (?, ?, ?, ?, ?, 'transferencia', ?, ?)`);
  return transacao(db, () => {
    const a = ins.run(empresaId, origem.id, data, -valor, descricao, grupo, req.usuario.id);
    const b = ins.run(empresaId, destino.id, data, valor, descricao, grupo, req.usuario.id);
    return { grupo, saida_id: Number(a.lastInsertRowid), entrada_id: Number(b.lastInsertRowid) };
  });
}

/** Saldo de cada conta: saldo inicial + movimentos até a data (inclusive). */
function saldos(db, empresaId, ate = '9999-12-31') {
  return db.prepare(`SELECT c.*, c.saldo_inicial_centavos + COALESCE((SELECT SUM(m.valor_centavos) FROM movimentos m
      WHERE m.conta_bancaria_id = c.id AND m.data <= ?), 0) AS saldo_centavos,
    (SELECT COUNT(*) FROM extrato x WHERE x.conta_bancaria_id = c.id AND x.status = 'pendente') AS extrato_pendente
    FROM contas_bancarias c WHERE c.empresa_id = ? ORDER BY c.ativo DESC, c.descricao`).all(ate, empresaId);
}

module.exports = { sinal, situacao, criar, buscar, editar, baixar, estornarBaixa, cancelar, transferir, saldos };
