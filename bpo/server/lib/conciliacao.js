'use strict';

const config = require('../config');
const { transacao } = require('../db');
const { naoEncontrado } = require('./erros');
const { daEmpresa } = require('./acesso');
const v = require('./validacao');
const { diferencaDias, somarDias } = require('./datas');
const lanc = require('./lancamentos');
const leitor = require('./extrato');

// Contas em aberto podem ser pagas alguns dias antes ou depois do vencimento.
const JANELA_ABERTOS_DIAS = 10;

/** Importa o arquivo do banco. Linhas já importadas (mesmo FITID na mesma conta) são ignoradas. */
function importar(db, req, empresaId, corpo) {
  const conta = daEmpresa(db, 'contas_bancarias', v.id(corpo.conta_bancaria_id), empresaId, 'Conta bancária');
  v.exigir(conta, 'Informe a conta bancária.');
  v.exigir(typeof corpo.conteudo === 'string' && corpo.conteudo.trim(), 'Arquivo vazio.');
  const { formato, itens } = leitor.ler(corpo.conteudo, corpo.formato);
  const existe = db.prepare('SELECT 1 FROM extrato WHERE conta_bancaria_id = ? AND fitid = ?');
  const ins = db.prepare(`INSERT INTO extrato (empresa_id, conta_bancaria_id, importacao_id, data, valor_centavos, descricao, documento, fitid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  return transacao(db, () => {
    const novos = itens.filter((i) => !existe.get(conta.id, i.fitid));
    const imp = db.prepare('INSERT INTO importacoes (empresa_id, conta_bancaria_id, arquivo, formato, itens, duplicados, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(empresaId, conta.id, v.texto(corpo.arquivo, 120), formato, novos.length, itens.length - novos.length, req.usuario.id);
    const impId = Number(imp.lastInsertRowid);
    for (const i of novos) ins.run(empresaId, conta.id, impId, i.data, i.valor_centavos, i.descricao, i.documento, i.fitid);
    const periodo = itens.length ? { de: itens.reduce((a, i) => (i.data < a ? i.data : a), itens[0].data), ate: itens.reduce((a, i) => (i.data > a ? i.data : a), itens[0].data) } : null;
    return { importacao_id: impId, formato, importados: novos.length, duplicados: itens.length - novos.length, periodo };
  });
}

function itemExtrato(db, empresaId, id) {
  const x = db.prepare('SELECT * FROM extrato WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!x) throw naoEncontrado('Item do extrato');
  return x;
}

const movimentosLivres = (db) => db.prepare(`SELECT m.*, l.tipo AS lancamento_tipo FROM movimentos m LEFT JOIN lancamentos l ON l.id = m.lancamento_id
  WHERE m.conta_bancaria_id = ? AND m.valor_centavos = ? AND m.data BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM extrato x WHERE x.movimento_id = m.id)`);

const abertosCompativeis = (db) => db.prepare(`SELECT l.*, c.nome AS contato_nome FROM lancamentos l LEFT JOIN contatos c ON c.id = l.contato_id
  WHERE l.empresa_id = ? AND l.status = 'aberto' AND l.tipo = ? AND l.valor_centavos = ?
    AND (l.conta_bancaria_id IS NULL OR l.conta_bancaria_id = ?) AND l.vencimento BETWEEN ? AND ?`);

/** Candidatos para um item do extrato: movimentos já lançados e contas em aberto do mesmo valor. */
function candidatos(db, empresaId, x) {
  const tol = config.toleranciaConciliacaoDias;
  const perto = (d) => (a, b) => Math.abs(diferencaDias(a[d], x.data)) - Math.abs(diferencaDias(b[d], x.data));
  const movimentos = movimentosLivres(db).all(x.conta_bancaria_id, x.valor_centavos, somarDias(x.data, -tol), somarDias(x.data, tol)).sort(perto('data'));
  const abertos = abertosCompativeis(db).all(empresaId, x.valor_centavos > 0 ? 'receber' : 'pagar', Math.abs(x.valor_centavos), x.conta_bancaria_id,
    somarDias(x.data, -JANELA_ABERTOS_DIAS), somarDias(x.data, JANELA_ABERTOS_DIAS)).sort(perto('vencimento'));
  return { movimentos, abertos };
}

/** Itens do extrato com sugestões de conciliação e movimentos do livro caixa ainda não conciliados. */
function painel(db, empresaId, contaId, { status = 'pendente', de, ate } = {}) {
  const conta = daEmpresa(db, 'contas_bancarias', contaId, empresaId, 'Conta bancária');
  const filtros = ['x.conta_bancaria_id = ?'];
  const params = [conta.id];
  if (status && status !== 'todos') { filtros.push('x.status = ?'); params.push(status); }
  if (de) { filtros.push('x.data >= ?'); params.push(de); }
  if (ate) { filtros.push('x.data <= ?'); params.push(ate); }
  const itens = db.prepare(`SELECT x.*, m.descricao AS movimento_descricao, m.data AS movimento_data, m.lancamento_id
    FROM extrato x LEFT JOIN movimentos m ON m.id = x.movimento_id WHERE ${filtros.join(' AND ')} ORDER BY x.data, x.id LIMIT 500`).all(...params)
    .map((x) => (x.status === 'pendente' ? { ...x, sugestoes: candidatos(db, empresaId, x) } : x));
  const resumo = db.prepare(`SELECT
      SUM(status = 'pendente') AS pendentes, SUM(status = 'conciliado') AS conciliados, SUM(status = 'ignorado') AS ignorados,
      MIN(data) AS primeira_data, MAX(data) AS ultima_data,
      COALESCE(SUM(CASE WHEN status <> 'ignorado' THEN valor_centavos END), 0) AS extrato_centavos
    FROM extrato WHERE conta_bancaria_id = ?`).get(conta.id);
  // Só o período coberto pelos extratos importados: antes dele não há com o que comparar.
  const naoConciliados = resumo.primeira_data ? db.prepare(`SELECT m.* FROM movimentos m WHERE m.conta_bancaria_id = ? AND m.data BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM extrato x WHERE x.movimento_id = m.id) ORDER BY m.data DESC LIMIT 200`).all(conta.id, resumo.primeira_data, resumo.ultima_data) : [];
  // Diferença do período: o que o sistema registrou menos o que o banco mostra. Zero = conta conciliada.
  resumo.sistema_centavos = resumo.primeira_data ? db.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM movimentos WHERE conta_bancaria_id = ? AND data BETWEEN ? AND ?')
    .get(conta.id, resumo.primeira_data, resumo.ultima_data).s : 0;
  resumo.diferenca_centavos = resumo.sistema_centavos - resumo.extrato_centavos;
  return { conta, itens, nao_conciliados: naoConciliados, resumo };
}

function marcar(db, req, x, movimentoId) {
  db.prepare("UPDATE extrato SET status = 'conciliado', movimento_id = ?, conciliado_por = ?, conciliado_em = datetime('now') WHERE id = ?")
    .run(movimentoId, req.usuario.id, x.id);
}

/** Concilia o item do extrato com um movimento já lançado (mesma conta e mesmo valor). */
function conciliarMovimento(db, req, empresaId, extratoId, movimentoId) {
  return transacao(db, () => {
    const x = itemExtrato(db, empresaId, extratoId);
    v.exigir(x.status === 'pendente', 'Item do extrato já tratado.');
    const m = db.prepare('SELECT * FROM movimentos WHERE id = ? AND empresa_id = ?').get(Number(movimentoId), empresaId);
    if (!m) throw naoEncontrado('Movimento');
    v.exigir(m.conta_bancaria_id === x.conta_bancaria_id, 'O movimento é de outra conta bancária.');
    v.exigir(m.valor_centavos === x.valor_centavos, 'Valores diferentes: o movimento não corresponde ao extrato.');
    v.exigir(!db.prepare('SELECT 1 FROM extrato WHERE movimento_id = ?').get(m.id), 'Este movimento já está conciliado.');
    marcar(db, req, x, m.id);
  });
}

/**
 * Baixa uma conta em aberto com a data e o valor do extrato e concilia. Diferença a maior vira juros;
 * a menor, desconto.
 */
function baixarEConciliar(db, req, empresaId, extratoId, lancamentoId) {
  return transacao(db, () => {
    const x = itemExtrato(db, empresaId, extratoId);
    v.exigir(x.status === 'pendente', 'Item do extrato já tratado.');
    const l = lanc.buscar(db, empresaId, lancamentoId);
    v.exigir(lanc.sinal(l.tipo) * x.valor_centavos > 0, x.valor_centavos > 0 ? 'Crédito no extrato só baixa conta a receber.' : 'Débito no extrato só baixa conta a pagar.');
    const diferenca = Math.abs(x.valor_centavos) - l.valor_centavos;
    const movimentoId = lanc.baixar(db, req, empresaId, l.id, {
      data: x.data, conta_bancaria_id: x.conta_bancaria_id,
      juros_centavos: Math.max(0, diferenca), desconto_centavos: Math.max(0, -diferenca),
    });
    marcar(db, req, x, movimentoId);
    return { lancamento_id: l.id, movimento_id: movimentoId };
  });
}

/** Cria o lançamento (já baixado) a partir do item do extrato: tarifas, rendimentos, recebimentos sem título. */
function criarLancamento(db, req, empresaId, extratoId, corpo) {
  return transacao(db, () => {
    const x = itemExtrato(db, empresaId, extratoId);
    v.exigir(x.status === 'pendente', 'Item do extrato já tratado.');
    const tipo = x.valor_centavos > 0 ? 'receber' : 'pagar';
    const [id] = lanc.criar(db, req, empresaId, {
      ...corpo, tipo, valor_centavos: Math.abs(x.valor_centavos), vencimento: x.data, competencia: corpo.competencia || x.data,
      descricao: corpo.descricao || x.descricao || 'Lançamento do extrato', conta_bancaria_id: x.conta_bancaria_id, parcelas: 1,
    });
    return baixarEConciliar(db, req, empresaId, x.id, id);
  });
}

function ignorar(db, req, empresaId, extratoId) {
  const x = itemExtrato(db, empresaId, extratoId);
  v.exigir(x.status === 'pendente', 'Item do extrato já tratado.');
  db.prepare("UPDATE extrato SET status = 'ignorado', conciliado_por = ?, conciliado_em = datetime('now') WHERE id = ?").run(req.usuario.id, x.id);
}

/** Desfaz a conciliação (a baixa, se houver, continua; estorne-a no lançamento se quiser). */
function desfazer(db, empresaId, extratoId) {
  const x = itemExtrato(db, empresaId, extratoId);
  v.exigir(x.status !== 'pendente', 'Item já está pendente.');
  db.prepare("UPDATE extrato SET status = 'pendente', movimento_id = NULL, conciliado_por = NULL, conciliado_em = NULL WHERE id = ?").run(x.id);
}

/**
 * Conciliação automática: concilia apenas pares inequívocos de mesmo valor — um único candidato para o
 * item do extrato, e esse candidato não serve para nenhum outro item pendente.
 */
function automatica(db, req, empresaId, contaId) {
  const conta = daEmpresa(db, 'contas_bancarias', contaId, empresaId, 'Conta bancária');
  v.exigir(conta, 'Informe a conta bancária.');
  const pendentes = db.prepare("SELECT * FROM extrato WHERE conta_bancaria_id = ? AND status = 'pendente' ORDER BY data, id").all(conta.id);
  const planos = pendentes.map((x) => {
    const { movimentos, abertos } = candidatos(db, empresaId, x);
    const exatosAbertos = abertos.filter((l) => Math.abs(diferencaDias(l.vencimento, x.data)) <= config.toleranciaConciliacaoDias);
    if (movimentos.length === 1 && !abertos.length) return { x, chave: `m${movimentos[0].id}`, acao: () => conciliarMovimento(db, req, empresaId, x.id, movimentos[0].id) };
    if (!movimentos.length && exatosAbertos.length === 1) return { x, chave: `l${exatosAbertos[0].id}`, acao: () => baixarEConciliar(db, req, empresaId, x.id, exatosAbertos[0].id) };
    return null;
  }).filter(Boolean);
  const uso = new Map();
  for (const p of planos) uso.set(p.chave, (uso.get(p.chave) ?? 0) + 1);
  let conciliados = 0;
  for (const p of planos) {
    if (uso.get(p.chave) !== 1) continue;
    p.acao();
    conciliados++;
  }
  return { conciliados, pendentes: pendentes.length - conciliados };
}

module.exports = { importar, painel, candidatos, conciliarMovimento, baixarEConciliar, criarLancamento, ignorar, desfazer, automatica };
