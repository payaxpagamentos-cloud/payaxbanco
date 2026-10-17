'use strict';

const crypto = require('node:crypto');
const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { daEmpresa } = require('./acesso');
const { exigirPeriodoAberto } = require('./periodo');
const v = require('./validacao');
const { somarMeses, hoje } = require('./datas');

const sinal = (tipo) => (tipo === 'receber' ? 1 : -1);
const autor = (req) => req?.usuario?.id ?? null;

/** Situação para a tela: aberto vira "vencido" depois do vencimento. */
const situacao = (l, dia = hoje()) => (l.status === 'aberto' && l.vencimento < dia ? 'vencido' : l.status);

/** Pagamentos que a empresa exige aprovar (acima do valor configurado) começam na conferência. */
function aprovacaoInicial(db, empresaId, tipo, valor) {
  if (tipo !== 'pagar') return 'dispensada';
  const e = db.prepare('SELECT aprovacao_ativa, aprovacao_acima_centavos FROM empresas WHERE id = ?').get(empresaId);
  return e?.aprovacao_ativa && valor > e.aprovacao_acima_centavos ? 'conferencia' : 'dispensada';
}

/**
 * Rateio entre centros de custo: [{ centro_custo_id, percentual }] com percentual em % (até 2 casas).
 * Retorna em centésimos de ponto (10000 = 100%) ou null quando não há rateio.
 */
function normalizarRateio(db, empresaId, rateio) {
  if (!Array.isArray(rateio) || !rateio.length) return null;
  v.exigir(rateio.length >= 2 && rateio.length <= 20, 'O rateio precisa de 2 a 20 centros de custo.');
  const itens = rateio.map((r) => {
    daEmpresa(db, 'centros_custo', v.id(r.centro_custo_id), empresaId, 'Centro de custo');
    const p = Math.round(Number(r.percentual) * 100);
    v.exigir(Number.isInteger(p) && p > 0 && p <= 10000, 'Percentual do rateio inválido.');
    return { centro_custo_id: Number(r.centro_custo_id), percentual: p };
  });
  v.exigir(new Set(itens.map((i) => i.centro_custo_id)).size === itens.length, 'Centro de custo repetido no rateio.');
  v.exigir(itens.reduce((a, i) => a + i.percentual, 0) === 10000, 'O rateio precisa somar 100%.');
  return itens;
}

function gravarRateio(db, lancamentoId, itens) {
  db.prepare('DELETE FROM rateios WHERE lancamento_id = ?').run(lancamentoId);
  const ins = db.prepare('INSERT INTO rateios (lancamento_id, centro_custo_id, percentual) VALUES (?, ?, ?)');
  for (const i of itens ?? []) ins.run(lancamentoId, i.centro_custo_id, i.percentual);
}

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
  const rateio = normalizarRateio(db, empresaId, corpo.rateio);
  return {
    descricao,
    contato_id: v.id(corpo.contato_id),
    categoria_id: categoria.id,
    // Com rateio, o centro de custo único deixa de valer.
    centro_custo_id: rateio ? null : v.id(corpo.centro_custo_id),
    conta_bancaria_id: v.id(corpo.conta_bancaria_id),
    documento: v.texto(corpo.documento, 60),
    observacoes: v.texto(corpo.observacoes, 1000),
    rateio,
  };
}

const INSERIR = `INSERT INTO lancamentos (empresa_id, tipo, descricao, contato_id, categoria_id, centro_custo_id, conta_bancaria_id,
  valor_centavos, competencia, vencimento, documento, parcela, total_parcelas, grupo, recorrente, observacoes, criado_por, aprovacao, origem_id, acordo_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Cria a conta a pagar/receber.
 * - `parcelas` > 1: divide o valor (a diferença de centavos vai na primeira) com vencimentos mensais.
 * - `repeticoes` > 1 (recorrência mensal: aluguel, mensalidades): repete o valor cheio todo mês.
 */
function criar(db, req, empresaId, corpo, extra = {}) {
  const tipo = corpo.tipo;
  v.exigir(['pagar', 'receber'].includes(tipo), 'Tipo deve ser "pagar" ou "receber".');
  const base = normalizar(db, empresaId, corpo, tipo);
  const total = v.valorCentavos(corpo.valor_centavos);
  const vencimento = v.data(corpo.vencimento, 'o vencimento');
  const competencia = v.data(corpo.competencia || vencimento, 'a competência');
  const parcelas = Number(corpo.parcelas ?? 1);
  const repeticoes = Number(corpo.repeticoes ?? 1);
  v.exigir(Number.isInteger(parcelas) && parcelas >= 1 && parcelas <= 120, 'Parcelas: de 1 a 120.');
  v.exigir(Number.isInteger(repeticoes) && repeticoes >= 1 && repeticoes <= 60, 'Recorrência: de 1 a 60 meses.');
  v.exigir(parcelas === 1 || repeticoes === 1, 'Escolha parcelamento ou recorrência, não os dois.');
  v.exigir(total >= parcelas, 'Valor menor que o número de parcelas.');
  exigirPeriodoAberto(db, empresaId, competencia);

  const n = Math.max(parcelas, repeticoes);
  const recorrente = repeticoes > 1 ? 1 : 0;
  const valorParcela = recorrente ? total : Math.floor(total / parcelas);
  const grupo = n > 1 ? crypto.randomUUID() : null;
  const inserir = db.prepare(INSERIR);
  return transacao(db, () => {
    const ids = [];
    for (let i = 1; i <= n; i++) {
      const valor = !recorrente && i === 1 ? total - valorParcela * (parcelas - 1) : valorParcela;
      const aprovacao = aprovacaoInicial(db, empresaId, tipo, valor);
      const r = inserir.run(empresaId, tipo, base.descricao, base.contato_id, base.categoria_id, base.centro_custo_id, base.conta_bancaria_id,
        valor, somarMeses(competencia, i - 1), somarMeses(vencimento, i - 1), base.documento, i, n, grupo, recorrente, base.observacoes,
        autor(req), aprovacao, extra.origem_id ?? null, extra.acordo_id ?? null);
      const id = Number(r.lastInsertRowid);
      gravarRateio(db, id, base.rateio);
      if (aprovacao !== 'dispensada') {
        db.prepare("INSERT INTO aprovacoes (lancamento_id, etapa, usuario_id, responsavel_id) VALUES (?, 'solicitado', ?, ?)")
          .run(id, autor(req), req?.responsavel?.id ?? null);
      }
      ids.push(id);
    }
    return ids;
  });
}

function buscar(db, empresaId, id) {
  const l = db.prepare('SELECT * FROM lancamentos WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!l) throw naoEncontrado('Lançamento');
  return l;
}

const rateioDe = (db, id) => db.prepare(`SELECT r.centro_custo_id, r.percentual, c.nome FROM rateios r JOIN centros_custo c ON c.id = r.centro_custo_id
  WHERE r.lancamento_id = ? ORDER BY r.percentual DESC`).all(id);

/**
 * Edita um lançamento em aberto. Pago ou cancelado não muda (estorne a baixa antes). Se um pagamento já
 * aprovado (ou recusado) muda de valor, volta para a conferência.
 */
function editar(db, req, empresaId, id, corpo) {
  return transacao(db, () => {
    const l = buscar(db, empresaId, id);
    v.exigir(l.status === 'aberto', 'Só é possível editar lançamentos em aberto.');
    const rateioAtual = rateioDe(db, l.id).map((r) => ({ centro_custo_id: r.centro_custo_id, percentual: r.percentual / 100 }));
    const base = normalizar(db, empresaId, { ...l, rateio: rateioAtual, ...corpo }, l.tipo);
    const valor = v.valorCentavos(corpo.valor_centavos ?? l.valor_centavos);
    const vencimento = v.data(corpo.vencimento ?? l.vencimento, 'o vencimento');
    const competencia = v.data(corpo.competencia ?? l.competencia, 'a competência');
    exigirPeriodoAberto(db, empresaId, l.competencia, competencia);
    let aprovacao = l.aprovacao;
    const novaExigencia = aprovacaoInicial(db, empresaId, l.tipo, valor);
    if ((l.aprovacao === 'aprovada' && valor > l.valor_centavos) || l.aprovacao === 'recusada' || (l.aprovacao === 'dispensada' && novaExigencia !== 'dispensada')) {
      aprovacao = novaExigencia;
      if (aprovacao !== 'dispensada') {
        db.prepare("INSERT INTO aprovacoes (lancamento_id, etapa, usuario_id, comentario) VALUES (?, 'reaberto', ?, 'Lançamento alterado')").run(l.id, autor(req));
      }
    }
    db.prepare(`UPDATE lancamentos SET descricao = ?, contato_id = ?, categoria_id = ?, centro_custo_id = ?, conta_bancaria_id = ?,
      valor_centavos = ?, competencia = ?, vencimento = ?, documento = ?, observacoes = ?, aprovacao = ? WHERE id = ?`)
      .run(base.descricao, base.contato_id, base.categoria_id, base.centro_custo_id, base.conta_bancaria_id, valor, competencia, vencimento,
        base.documento, base.observacoes, aprovacao, l.id);
    gravarRateio(db, l.id, base.rateio);
    return { antes: l, depois: buscar(db, empresaId, id) };
  });
}

/**
 * Baixa (pagamento ou recebimento): grava data, valor pago, juros e desconto e lança o movimento na
 * conta bancária. Valor pago = principal + juros - desconto.
 * Baixa parcial (`valor_principal_centavos` menor que o valor): o lançamento é dividido — a parte paga
 * fica baixada e o saldo vira um novo lançamento em aberto, com o mesmo vencimento.
 * Retorna o id do movimento criado.
 */
function baixar(db, req, empresaId, id, corpo) {
  return transacao(db, () => {
    let l = buscar(db, empresaId, id);
    v.exigir(l.status === 'aberto', l.status === 'pago' ? 'Este lançamento já foi baixado.' : 'Lançamento cancelado.');
    if (l.tipo === 'pagar' && !['dispensada', 'aprovada'].includes(l.aprovacao)) {
      throw new ErroNegocio(l.aprovacao === 'recusada' ? 'Pagamento recusado na aprovação.' : 'Pagamento aguardando aprovação.', 409);
    }
    const conta = daEmpresa(db, 'contas_bancarias', v.id(corpo.conta_bancaria_id ?? l.conta_bancaria_id), empresaId, 'Conta bancária');
    v.exigir(conta, 'Informe a conta bancária da baixa.');
    v.exigir(conta.ativo, 'Conta bancária inativa.');
    const data = v.data(corpo.data ?? hoje(), 'a data da baixa');
    exigirPeriodoAberto(db, empresaId, data);
    const juros = v.valorCentavos(corpo.juros_centavos ?? 0, 'juros', { zero: true });
    const desconto = v.valorCentavos(corpo.desconto_centavos ?? 0, 'desconto', { zero: true });
    const principal = corpo.valor_principal_centavos == null ? l.valor_centavos : v.valorCentavos(corpo.valor_principal_centavos, 'valor da baixa');
    v.exigir(principal <= l.valor_centavos, 'O valor da baixa não pode ser maior que o valor em aberto.');
    if (principal < l.valor_centavos) {
      const resto = l.valor_centavos - principal;
      const r = db.prepare(INSERIR).run(empresaId, l.tipo, l.descricao, l.contato_id, l.categoria_id, l.centro_custo_id, l.conta_bancaria_id,
        resto, l.competencia, l.vencimento, l.documento, l.parcela, l.total_parcelas, l.grupo, l.recorrente,
        `Saldo da baixa parcial do lançamento #${l.id}.${l.observacoes ? ` ${l.observacoes}` : ''}`.slice(0, 1000), autor(req), l.aprovacao, l.id, l.acordo_id);
      const novo = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO rateios (lancamento_id, centro_custo_id, percentual) SELECT ?, centro_custo_id, percentual FROM rateios WHERE lancamento_id = ?').run(novo, l.id);
      db.prepare('UPDATE lancamentos SET valor_centavos = ? WHERE id = ?').run(principal, l.id);
      l = buscar(db, empresaId, id);
    }
    const pago = l.valor_centavos + juros - desconto;
    v.exigir(pago > 0, 'O desconto não pode ser maior ou igual ao valor.');
    db.prepare(`UPDATE lancamentos SET status = 'pago', pago_em = ?, valor_pago_centavos = ?, juros_centavos = ?, desconto_centavos = ?,
      conta_bancaria_id = ? WHERE id = ?`).run(data, pago, juros, desconto, conta.id, l.id);
    const r = db.prepare(`INSERT INTO movimentos (empresa_id, conta_bancaria_id, data, valor_centavos, descricao, origem, lancamento_id, usuario_id)
      VALUES (?, ?, ?, ?, ?, 'baixa', ?, ?)`).run(empresaId, conta.id, data, sinal(l.tipo) * pago, l.descricao, l.id, autor(req));
    return Number(r.lastInsertRowid);
  });
}

/** Desfaz a baixa. Se o movimento já estava conciliado com o extrato, a linha do extrato volta a ficar pendente. */
function estornarBaixa(db, empresaId, id) {
  return transacao(db, () => {
    const l = buscar(db, empresaId, id);
    v.exigir(l.status === 'pago', 'Este lançamento não está baixado.');
    exigirPeriodoAberto(db, empresaId, l.pago_em);
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
  exigirPeriodoAberto(db, empresaId, l.competencia);
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
  exigirPeriodoAberto(db, empresaId, data);
  const descricao = v.texto(corpo.descricao, 200) || `Transferência ${origem.descricao} → ${destino.descricao}`;
  const grupo = crypto.randomUUID();
  const ins = db.prepare(`INSERT INTO movimentos (empresa_id, conta_bancaria_id, data, valor_centavos, descricao, origem, grupo, usuario_id)
    VALUES (?, ?, ?, ?, ?, 'transferencia', ?, ?)`);
  return transacao(db, () => {
    const a = ins.run(empresaId, origem.id, data, -valor, descricao, grupo, autor(req));
    const b = ins.run(empresaId, destino.id, data, valor, descricao, grupo, autor(req));
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

module.exports = { sinal, situacao, criar, buscar, editar, baixar, estornarBaixa, cancelar, transferir, saldos, rateioDe };
