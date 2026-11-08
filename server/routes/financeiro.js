'use strict';

const { Router } = require('express');
const { transacao } = require('../db');
const { naoEncontrado } = require('../lib/erros');
const { registrar, diferencas } = require('../lib/auditoria');
const { resumoEmpresa } = require('../lib/resumo');
const { lerBoleto } = require('../lib/boleto');
const { exigirPeriodoAberto } = require('../lib/periodo');
const aprov = require('../lib/aprovacao');
const docs = require('../lib/documentos');
const { gruposDoTipo, GRUPOS_DRE } = require('../lib/plano-contas');
const { hoje, inicioMes } = require('../lib/datas');
const lanc = require('../lib/lancamentos');
const conc = require('../lib/conciliacao');
const rel = require('../lib/relatorios');
const v = require('../lib/validacao');

/** Célula de CSV protegida contra injeção de fórmulas no Excel. */
function celula(x) {
  let s = String(x ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const reais = (c) => (c / 100).toFixed(2).replace('.', ',');
function enviarCsv(res, nome, linhas) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nome}"` });
  res.send(`﻿${linhas.map((l) => l.map(celula).join(';')).join('\r\n')}\r\n`);
}

/** Rotas do financeiro de uma empresa (req.empresa já carregada e com acesso conferido). */
module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;
  const audit = (req, acao, detalhes) => registrar(db, req, acao, detalhes, eid(req));

  // ---------- Visão da empresa ----------
  r.get('/resumo', (req, res) => res.json(resumoEmpresa(db, eid(req))));

  // ---------- Cadastros: categorias (plano de contas) ----------
  r.get('/categorias', (req, res) => {
    res.json({ grupos: GRUPOS_DRE, itens: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM lancamentos l WHERE l.categoria_id = c.id) AS uso
      FROM categorias c WHERE c.empresa_id = ? ORDER BY c.tipo DESC, c.nome`).all(eid(req)) });
  });
  const dadosCategoria = (b, atual = {}) => {
    const d = { ...atual, ...b };
    const nome = v.texto(d.nome, 80);
    v.exigir(nome, 'Informe o nome.');
    v.exigir(['receita', 'despesa'].includes(d.tipo), 'Tipo deve ser receita ou despesa.');
    v.exigir(gruposDoTipo(d.tipo).includes(d.grupo_dre), 'Grupo da DRE incompatível com o tipo.');
    return { nome, tipo: d.tipo, grupo_dre: d.grupo_dre, conta_contabil: v.texto(d.conta_contabil, 40), ativo: d.ativo === undefined ? 1 : d.ativo ? 1 : 0 };
  };
  r.post('/categorias', (req, res) => {
    const d = dadosCategoria(req.body);
    const x = db.prepare('INSERT INTO categorias (empresa_id, nome, tipo, grupo_dre, conta_contabil) VALUES (?, ?, ?, ?, ?)').run(eid(req), d.nome, d.tipo, d.grupo_dre, d.conta_contabil);
    audit(req, 'categoria_criada', d);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.patch('/categorias/:id', (req, res) => {
    const atual = db.prepare('SELECT * FROM categorias WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), eid(req));
    if (!atual) throw naoEncontrado('Categoria');
    const d = dadosCategoria(req.body, atual);
    // O tipo não muda depois de usada: inverteria contas a pagar e a receber já lançadas.
    if (d.tipo !== atual.tipo) v.exigir(!db.prepare('SELECT 1 FROM lancamentos WHERE categoria_id = ?').get(atual.id), 'Categoria já usada: não é possível trocar o tipo.');
    db.prepare('UPDATE categorias SET nome = ?, tipo = ?, grupo_dre = ?, conta_contabil = ?, ativo = ? WHERE id = ?').run(d.nome, d.tipo, d.grupo_dre, d.conta_contabil, d.ativo, atual.id);
    audit(req, 'categoria_alterada', { id: atual.id, alteracoes: diferencas(atual, d) });
    res.status(204).end();
  });

  // ---------- Centros de custo ----------
  r.get('/centros', (req, res) => res.json(db.prepare('SELECT * FROM centros_custo WHERE empresa_id = ? ORDER BY ativo DESC, nome').all(eid(req))));
  r.post('/centros', (req, res) => {
    const nome = v.texto(req.body.nome, 80);
    v.exigir(nome, 'Informe o nome.');
    const x = db.prepare('INSERT INTO centros_custo (empresa_id, nome) VALUES (?, ?)').run(eid(req), nome);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.patch('/centros/:id', (req, res) => {
    const atual = db.prepare('SELECT * FROM centros_custo WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), eid(req));
    if (!atual) throw naoEncontrado('Centro de custo');
    db.prepare('UPDATE centros_custo SET nome = ?, ativo = ? WHERE id = ?')
      .run(v.texto(req.body.nome, 80) ?? atual.nome, req.body.ativo === undefined ? atual.ativo : req.body.ativo ? 1 : 0, atual.id);
    res.status(204).end();
  });

  // ---------- Contatos (fornecedores e clientes) ----------
  r.get('/contatos', (req, res) => {
    const filtros = ['empresa_id = ?'];
    const params = [eid(req)];
    if (req.query.tipo) { filtros.push("(tipo = ? OR tipo = 'ambos')"); params.push(req.query.tipo); }
    if (req.query.busca) { filtros.push('(nome LIKE ? OR documento LIKE ?)'); params.push(`%${req.query.busca}%`, `%${v.digitos(req.query.busca) || req.query.busca}%`); }
    res.json(db.prepare(`SELECT * FROM contatos WHERE ${filtros.join(' AND ')} ORDER BY ativo DESC, nome LIMIT 500`).all(...params));
  });
  const dadosContato = (b, atual = {}) => {
    const d = { ...atual, ...b };
    const nome = v.texto(d.nome, 160);
    v.exigir(nome, 'Informe o nome.');
    v.exigir(['fornecedor', 'cliente', 'ambos'].includes(d.tipo), 'Tipo inválido.');
    const email = v.texto(d.email, 120);
    v.exigir(!email || v.emailValido(email), 'E-mail inválido.');
    return { tipo: d.tipo, nome, documento: v.documentoOpcional(d.documento), email, telefone: v.digitos(d.telefone) || null,
      chave_pix: v.texto(d.chave_pix, 120), observacoes: v.texto(d.observacoes, 1000), ativo: d.ativo === undefined ? 1 : d.ativo ? 1 : 0 };
  };
  r.post('/contatos', (req, res) => {
    const d = dadosContato(req.body);
    const x = db.prepare('INSERT INTO contatos (empresa_id, tipo, nome, documento, email, telefone, chave_pix, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(eid(req), d.tipo, d.nome, d.documento, d.email, d.telefone, d.chave_pix, d.observacoes);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.patch('/contatos/:id', (req, res) => {
    const atual = db.prepare('SELECT * FROM contatos WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), eid(req));
    if (!atual) throw naoEncontrado('Contato');
    const d = dadosContato(req.body, atual);
    db.prepare('UPDATE contatos SET tipo = ?, nome = ?, documento = ?, email = ?, telefone = ?, chave_pix = ?, observacoes = ?, ativo = ? WHERE id = ?')
      .run(d.tipo, d.nome, d.documento, d.email, d.telefone, d.chave_pix, d.observacoes, d.ativo, atual.id);
    res.status(204).end();
  });

  // ---------- Contas bancárias e livro caixa ----------
  r.get('/contas-bancarias', (req, res) => res.json(lanc.saldos(db, eid(req))));
  const dadosConta = (b, atual = {}) => {
    const d = { ...atual, ...b };
    const descricao = v.texto(d.descricao, 80);
    const banco = v.texto(d.banco, 80);
    v.exigir(descricao && banco, 'Informe a descrição e o banco.');
    const saldo = Number(d.saldo_inicial_centavos ?? 0);
    v.exigir(Number.isInteger(saldo), 'Saldo inicial inválido.');
    return { descricao, banco, agencia: v.texto(d.agencia, 20), numero: v.texto(d.numero, 30), saldo_inicial_centavos: saldo,
      data_saldo_inicial: v.data(d.data_saldo_inicial || hoje(), 'a data do saldo inicial'), conta_contabil: v.texto(d.conta_contabil, 40), ativo: d.ativo === undefined ? 1 : d.ativo ? 1 : 0 };
  };
  r.post('/contas-bancarias', (req, res) => {
    const d = dadosConta(req.body);
    const x = db.prepare('INSERT INTO contas_bancarias (empresa_id, descricao, banco, agencia, numero, saldo_inicial_centavos, data_saldo_inicial, conta_contabil) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(eid(req), d.descricao, d.banco, d.agencia, d.numero, d.saldo_inicial_centavos, d.data_saldo_inicial, d.conta_contabil);
    audit(req, 'conta_bancaria_criada', d);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.patch('/contas-bancarias/:id', (req, res) => {
    const atual = db.prepare('SELECT * FROM contas_bancarias WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), eid(req));
    if (!atual) throw naoEncontrado('Conta bancária');
    const d = dadosConta(req.body, atual);
    db.prepare('UPDATE contas_bancarias SET descricao = ?, banco = ?, agencia = ?, numero = ?, saldo_inicial_centavos = ?, data_saldo_inicial = ?, conta_contabil = ?, ativo = ? WHERE id = ?')
      .run(d.descricao, d.banco, d.agencia, d.numero, d.saldo_inicial_centavos, d.data_saldo_inicial, d.conta_contabil, d.ativo, atual.id);
    audit(req, 'conta_bancaria_alterada', { id: atual.id, alteracoes: diferencas(atual, d) });
    res.status(204).end();
  });
  r.get('/contas-bancarias/:id/movimentos', (req, res) => {
    const conta = db.prepare('SELECT * FROM contas_bancarias WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), eid(req));
    if (!conta) throw naoEncontrado('Conta bancária');
    const de = req.query.de || inicioMes(hoje());
    const ate = req.query.ate || hoje();
    v.data(de, 'a data inicial');
    v.data(ate, 'a data final');
    const anterior = conta.saldo_inicial_centavos + db.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM movimentos WHERE conta_bancaria_id = ? AND data < ?').get(conta.id, de).s;
    let saldo = anterior;
    const itens = db.prepare(`SELECT m.*, l.tipo AS lancamento_tipo, c.nome AS categoria, x.id AS extrato_id FROM movimentos m
      LEFT JOIN lancamentos l ON l.id = m.lancamento_id LEFT JOIN categorias c ON c.id = l.categoria_id LEFT JOIN extrato x ON x.movimento_id = m.id
      WHERE m.conta_bancaria_id = ? AND m.data BETWEEN ? AND ? ORDER BY m.data, m.id`).all(conta.id, de, ate)
      .map((m) => { saldo += m.valor_centavos; return { ...m, saldo_centavos: saldo }; });
    res.json({ conta, de, ate, saldo_anterior_centavos: anterior, saldo_final_centavos: saldo, itens });
  });
  r.post('/transferencias', (req, res) => {
    const t = lanc.transferir(db, req, eid(req), req.body);
    audit(req, 'transferencia', { ...t, valor_centavos: req.body.valor_centavos });
    res.status(201).json(t);
  });
  r.post('/ajustes', (req, res) => {
    const conta = db.prepare('SELECT * FROM contas_bancarias WHERE id = ? AND empresa_id = ?').get(Number(req.body.conta_bancaria_id), eid(req));
    v.exigir(conta, 'Conta bancária não encontrada.');
    const valor = Number(req.body.valor_centavos);
    v.exigir(Number.isInteger(valor) && valor !== 0 && Math.abs(valor) <= 100_000_000_000, 'Valor do ajuste inválido (centavos, com sinal).');
    const descricao = v.texto(req.body.descricao, 200);
    v.exigir(descricao, 'Informe o motivo do ajuste.');
    const data = v.data(req.body.data || hoje(), 'a data');
    exigirPeriodoAberto(db, eid(req), data);
    const x = db.prepare(`INSERT INTO movimentos (empresa_id, conta_bancaria_id, data, valor_centavos, descricao, origem, usuario_id) VALUES (?, ?, ?, ?, ?, 'ajuste', ?)`)
      .run(eid(req), conta.id, data, valor, descricao, req.usuario.id);
    audit(req, 'ajuste_saldo', { conta_bancaria_id: conta.id, valor_centavos: valor, descricao });
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.delete('/movimentos/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM movimentos WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), eid(req));
    if (!m) throw naoEncontrado('Movimento');
    v.exigir(m.origem !== 'baixa', 'Movimento de baixa: estorne a baixa no lançamento.');
    exigirPeriodoAberto(db, eid(req), m.data);
    transacao(db, () => {
      const ids = m.grupo ? db.prepare('SELECT id FROM movimentos WHERE grupo = ?').all(m.grupo).map((x) => x.id) : [m.id];
      for (const id of ids) {
        v.exigir(!db.prepare('SELECT 1 FROM extrato WHERE movimento_id = ?').get(id), 'Movimento conciliado: desfaça a conciliação antes.');
        db.prepare('DELETE FROM movimentos WHERE id = ?').run(id);
      }
    });
    audit(req, 'movimento_excluido', { id: m.id, origem: m.origem, valor_centavos: m.valor_centavos });
    res.status(204).end();
  });

  // ---------- Contas a pagar e a receber ----------
  function consultaLancamentos(req) {
    const q = req.query;
    const dia = hoje();
    const filtros = ['l.empresa_id = ?'];
    const params = [eid(req)];
    if (q.tipo) { filtros.push('l.tipo = ?'); params.push(q.tipo); }
    if (q.status === 'vencido') { filtros.push("l.status = 'aberto' AND l.vencimento < ?"); params.push(dia); }
    else if (q.status === 'a_vencer') { filtros.push("l.status = 'aberto' AND l.vencimento >= ?"); params.push(dia); }
    else if (q.status && q.status !== 'todos') { filtros.push('l.status = ?'); params.push(q.status); }
    const campoData = { competencia: 'l.competencia', pagamento: 'l.pago_em' }[q.data_por] ?? 'l.vencimento';
    if (q.de) { filtros.push(`${campoData} >= ?`); params.push(q.de); }
    if (q.ate) { filtros.push(`${campoData} <= ?`); params.push(q.ate); }
    for (const campo of ['categoria_id', 'contato_id', 'centro_custo_id', 'conta_bancaria_id']) {
      if (q[campo]) { filtros.push(`l.${campo} = ?`); params.push(Number(q[campo])); }
    }
    if (q.busca) { filtros.push('(l.descricao LIKE ? OR l.documento LIKE ? OR ct.nome LIKE ?)'); const b = `%${q.busca}%`; params.push(b, b, b); }
    if (q.aprovacao) { filtros.push('l.aprovacao = ?'); params.push(q.aprovacao); }
    return { where: filtros.join(' AND '), params, dia };
  }
  const SELECT_LANC = `SELECT l.*, (SELECT COUNT(*) FROM rateios r WHERE r.lancamento_id = l.id) AS rateado,
    (SELECT COUNT(*) FROM documentos d WHERE d.lancamento_id = l.id) AS documentos, ct.nome AS contato_nome, cat.nome AS categoria_nome, cc.nome AS centro_nome, cb.descricao AS conta_nome
    FROM lancamentos l LEFT JOIN contatos ct ON ct.id = l.contato_id LEFT JOIN categorias cat ON cat.id = l.categoria_id
    LEFT JOIN centros_custo cc ON cc.id = l.centro_custo_id LEFT JOIN contas_bancarias cb ON cb.id = l.conta_bancaria_id`;

  r.get('/lancamentos', (req, res) => {
    const { where, params, dia } = consultaLancamentos(req);
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const limite = Math.min(200, Number(req.query.limite) || 50);
    const totais = db.prepare(`SELECT COUNT(*) AS quantidade, COALESCE(SUM(l.valor_centavos), 0) AS valor_centavos,
        COALESCE(SUM(CASE WHEN l.status = 'aberto' THEN l.valor_centavos END), 0) AS aberto_centavos,
        COALESCE(SUM(CASE WHEN l.status = 'aberto' AND l.vencimento < ? THEN l.valor_centavos END), 0) AS vencido_centavos,
        COALESCE(SUM(l.valor_pago_centavos), 0) AS pago_centavos
      FROM lancamentos l LEFT JOIN contatos ct ON ct.id = l.contato_id WHERE ${where}`).get(dia, ...params);
    const itens = db.prepare(`${SELECT_LANC} WHERE ${where} ORDER BY l.vencimento, l.id LIMIT ? OFFSET ?`).all(...params, limite, (pagina - 1) * limite)
      .map((l) => ({ ...l, situacao: lanc.situacao(l, dia) }));
    res.json({ itens, totais, total: totais.quantidade, pagina, limite });
  });

  r.get('/lancamentos.csv', (req, res) => {
    const { where, params, dia } = consultaLancamentos(req);
    const itens = db.prepare(`${SELECT_LANC} WHERE ${where} ORDER BY l.vencimento, l.id LIMIT 20000`).all(...params);
    enviarCsv(res, `lancamentos-${req.empresa.cnpj}.csv`, [
      ['Tipo', 'Situação', 'Descrição', 'Contato', 'Categoria', 'Centro de custo', 'Documento', 'Parcela', 'Competência', 'Vencimento', 'Valor', 'Pago em', 'Valor pago', 'Juros', 'Desconto', 'Conta'],
      ...itens.map((l) => [l.tipo === 'pagar' ? 'A pagar' : 'A receber', lanc.situacao(l, dia), l.descricao, l.contato_nome, l.categoria_nome, l.centro_nome, l.documento,
        `${l.parcela}/${l.total_parcelas}`, l.competencia, l.vencimento, reais(l.valor_centavos), l.pago_em, l.valor_pago_centavos == null ? '' : reais(l.valor_pago_centavos),
        reais(l.juros_centavos), reais(l.desconto_centavos), l.conta_nome]),
    ]);
  });

  r.post('/lancamentos', (req, res) => {
    // Com `baixar`, o lançamento (sem parcelas) já entra pago; se a baixa falhar, nada é gravado.
    const baixar = Boolean(req.body.baixar);
    v.exigir(!baixar || Number(req.body.parcelas ?? 1) === 1, 'Lançamento parcelado não pode ser baixado na criação.');
    // Boleto: valida a linha digitável e guarda (só lançamento único).
    const boleto = req.body.codigo_barras ? lerBoleto(req.body.codigo_barras) : null;
    v.exigir(!boleto || (Number(req.body.parcelas ?? 1) === 1 && Number(req.body.repeticoes ?? 1) === 1), 'Linha digitável só em lançamento único.');
    const ids = transacao(db, () => {
      const novos = lanc.criar(db, req, eid(req), req.body);
      if (boleto) db.prepare('UPDATE lancamentos SET codigo_barras = ? WHERE id = ?').run(boleto.linha_digitavel, novos[0]);
      if (baixar) lanc.baixar(db, req, eid(req), novos[0], req.body.baixa ?? {});
      return novos;
    });
    audit(req, 'lancamento_criado', { ids, tipo: req.body.tipo, valor_centavos: req.body.valor_centavos, descricao: req.body.descricao, baixado: baixar });
    res.status(201).json({ ids });
  });

  r.get('/lancamentos/:id', (req, res) => {
    const l = db.prepare(`${SELECT_LANC} WHERE l.id = ? AND l.empresa_id = ?`).get(Number(req.params.id), eid(req));
    if (!l) throw naoEncontrado('Lançamento');
    const parcelas = l.grupo ? db.prepare('SELECT id, parcela, total_parcelas, vencimento, valor_centavos, status FROM lancamentos WHERE grupo = ? ORDER BY parcela').all(l.grupo) : [];
    const extrato = db.prepare('SELECT x.* FROM extrato x JOIN movimentos m ON m.id = x.movimento_id WHERE m.lancamento_id = ?').get(l.id) ?? null;
    const origem = l.origem_id ? db.prepare('SELECT id, valor_centavos, status FROM lancamentos WHERE id = ?').get(l.origem_id) : null;
    const saldos = db.prepare('SELECT id, valor_centavos, status FROM lancamentos WHERE origem_id = ?').all(l.id);
    res.json({ ...l, situacao: lanc.situacao(l), parcelas, extrato, rateio: lanc.rateioDe(db, l.id), aprovacoes: aprov.historico(db, l.id),
      documentos: docs.listar(db, eid(req), { lancamento_id: l.id }), origem, saldos });
  });

  r.patch('/lancamentos/:id', (req, res) => {
    if ('codigo_barras' in req.body) {
      const b = req.body.codigo_barras ? lerBoleto(req.body.codigo_barras) : null;
      db.prepare("UPDATE lancamentos SET codigo_barras = ? WHERE id = ? AND empresa_id = ? AND status = 'aberto'").run(b?.linha_digitavel ?? null, Number(req.params.id), eid(req));
    }
    const { antes, depois } = lanc.editar(db, req, eid(req), req.params.id, req.body);
    audit(req, 'lancamento_alterado', { id: depois.id, alteracoes: diferencas(antes, depois) });
    res.json(depois);
  });

  r.post('/lancamentos/:id/baixa', (req, res) => {
    const movimento = lanc.baixar(db, req, eid(req), req.params.id, req.body);
    audit(req, 'lancamento_baixado', { id: Number(req.params.id), movimento_id: movimento, parcial: req.body.valor_principal_centavos != null });
    res.json({ movimento_id: movimento });
  });

  // Baixa em lote: mesma data e conta para todos os selecionados. Tudo ou nada.
  r.post('/lancamentos/baixa-lote', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    v.exigir(ids.length && ids.length <= 200, 'Selecione de 1 a 200 lançamentos.');
    transacao(db, () => { for (const id of ids) lanc.baixar(db, req, eid(req), id, { data: req.body.data, conta_bancaria_id: req.body.conta_bancaria_id }); });
    audit(req, 'baixa_em_lote', { ids });
    res.json({ baixados: ids.length });
  });

  r.post('/lancamentos/:id/estorno', (req, res) => {
    lanc.estornarBaixa(db, eid(req), req.params.id);
    audit(req, 'baixa_estornada', { id: Number(req.params.id) });
    res.status(204).end();
  });

  r.post('/lancamentos/:id/cancelar', (req, res) => {
    lanc.cancelar(db, eid(req), req.params.id);
    audit(req, 'lancamento_cancelado', { id: Number(req.params.id), motivo: v.texto(req.body.motivo, 300) });
    res.status(204).end();
  });

  // ---------- Extrato e conciliação ----------
  r.post('/extrato/importar', (req, res) => {
    const r2 = conc.importar(db, req, eid(req), req.body);
    audit(req, 'extrato_importado', { conta_bancaria_id: Number(req.body.conta_bancaria_id), ...r2 });
    res.status(201).json(r2);
  });
  r.get('/conciliacao', (req, res) => {
    v.exigir(req.query.conta_bancaria_id, 'Informe a conta bancária.');
    res.json(conc.painel(db, eid(req), Number(req.query.conta_bancaria_id), req.query));
  });
  r.get('/importacoes', (req, res) => {
    res.json(db.prepare(`SELECT i.*, u.nome AS usuario_nome, c.descricao AS conta_nome FROM importacoes i LEFT JOIN usuarios u ON u.id = i.usuario_id
      JOIN contas_bancarias c ON c.id = i.conta_bancaria_id WHERE i.empresa_id = ? ORDER BY i.id DESC LIMIT 50`).all(eid(req)));
  });
  r.post('/extrato/automatica', (req, res) => {
    const r2 = conc.automatica(db, req, eid(req), Number(req.body.conta_bancaria_id));
    audit(req, 'conciliacao_automatica', { conta_bancaria_id: Number(req.body.conta_bancaria_id), ...r2 });
    res.json(r2);
  });
  r.post('/extrato/:id/conciliar', (req, res) => {
    let r2;
    if (req.body.movimento_id) r2 = conc.conciliarMovimento(db, req, eid(req), req.params.id, req.body.movimento_id);
    else if (req.body.lancamento_id) r2 = conc.baixarEConciliar(db, req, eid(req), req.params.id, req.body.lancamento_id);
    else v.exigir(false, 'Informe o movimento ou o lançamento.');
    audit(req, 'extrato_conciliado', { extrato_id: Number(req.params.id), movimento_id: req.body.movimento_id, lancamento_id: req.body.lancamento_id });
    res.json(r2 ?? {});
  });
  r.post('/extrato/:id/lancar', (req, res) => {
    const r2 = conc.criarLancamento(db, req, eid(req), req.params.id, req.body);
    audit(req, 'extrato_lancado', { extrato_id: Number(req.params.id), ...r2 });
    res.status(201).json(r2);
  });
  r.post('/extrato/:id/ignorar', (req, res) => {
    conc.ignorar(db, req, eid(req), req.params.id);
    audit(req, 'extrato_ignorado', { extrato_id: Number(req.params.id) });
    res.status(204).end();
  });
  r.post('/extrato/:id/desfazer', (req, res) => {
    conc.desfazer(db, eid(req), req.params.id);
    audit(req, 'conciliacao_desfeita', { extrato_id: Number(req.params.id) });
    res.status(204).end();
  });

  // ---------- Relatórios ----------
  r.get('/fluxo-caixa', (req, res) => res.json(rel.fluxoCaixa(db, eid(req), req.query)));
  r.get('/dre', (req, res) => res.json(rel.dre(db, eid(req), req.query)));
  r.get('/resultado-centros', (req, res) => res.json(rel.porCentro(db, eid(req), req.query)));
  r.get('/dre.csv', (req, res) => {
    const d = rel.dre(db, eid(req), req.query);
    const linhas = [['Linha', ...d.meses, 'Total']];
    for (const l of d.linhas) {
      const sinal = l.tipo === 'grupo' ? l.sinal : 1;
      linhas.push([l.tipo === 'subtotal' ? `= ${l.rotulo}` : l.rotulo, ...d.meses.map((m) => reais(sinal * l.valores[m])), reais(sinal * l.total)]);
      for (const c of l.categorias ?? []) linhas.push([`   ${c.nome}`, ...d.meses.map((m) => reais(sinal * c.valores[m])), reais(sinal * c.total)]);
    }
    enviarCsv(res, `dre-${req.empresa.cnpj}-${d.de}-${d.ate}.csv`, linhas);
  });

  return r;
};
