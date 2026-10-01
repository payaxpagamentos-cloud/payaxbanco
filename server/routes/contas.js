'use strict';

const { Router } = require('express');
const alcadas = require('../lib/alcadas');

const { alcada } = alcadas;
const situacao = require('../lib/situacao');
const ouvidoria = require('../lib/ouvidoria');
const { transacao } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const v = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');
const { paginacao } = require('../lib/paginacao');
const { proximoNumero, buscarConta } = require('../lib/conta');

const TIPOS = ['corrente', 'poupanca', 'pagamento', 'salario'];

module.exports = (db) => {
  const r = Router();

  r.get('/', (req, res) => {
    const { limite, offset, pagina } = paginacao(req.query);
    const filtros = [];
    const params = [];
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      filtros.push("(cl.nome LIKE ? OR cl.documento LIKE ? OR c.numero LIKE ? OR (c.numero || '-' || c.digito) LIKE ?)");
      params.push(q, `%${v.digitos(req.query.q) || req.query.q}%`, q, q);
    }
    if (req.query.status) { filtros.push('c.status = ?'); params.push(req.query.status); }
    if (req.query.tipo) { filtros.push('c.tipo = ?'); params.push(req.query.tipo); }
    if (req.query.cliente_id) { filtros.push('c.cliente_id = ?'); params.push(req.query.cliente_id); }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const base = `FROM contas c JOIN clientes cl ON cl.id = c.cliente_id ${where}`;
    const { total } = db.prepare(`SELECT COUNT(*) AS total ${base}`).get(...params);
    const itens = db.prepare(`SELECT c.*, cl.nome AS cliente_nome, cl.documento AS cliente_documento, cl.tipo AS cliente_tipo
      ${base} ORDER BY c.aberta_em DESC, c.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
    res.json({ itens, total, pagina, limite });
  });

  r.get('/:id', (req, res) => {
    const conta = buscarConta(db, req.params.id);
    conta.chaves_pix = db.prepare('SELECT * FROM chaves_pix WHERE conta_id = ? ORDER BY criado_em').all(conta.id);
    res.json(conta);
  });

  r.get('/:id/extrato', (req, res) => {
    const conta = buscarConta(db, req.params.id);
    const { limite, offset, pagina } = paginacao(req.query);
    const filtros = ['t.conta_id = ?'];
    const params = [conta.id];
    if (req.query.inicio) { v.exigir(v.dataValida(req.query.inicio), 'Data inicial inválida.'); filtros.push('date(t.criado_em) >= ?'); params.push(req.query.inicio); }
    if (req.query.fim) { v.exigir(v.dataValida(req.query.fim), 'Data final inválida.'); filtros.push('date(t.criado_em) <= ?'); params.push(req.query.fim); }
    const where = filtros.join(' AND ');
    const resumo = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN valor_centavos > 0 THEN valor_centavos END),0) AS entradas_centavos,
        COALESCE(SUM(CASE WHEN valor_centavos < 0 THEN valor_centavos END),0) AS saidas_centavos
      FROM transacoes t WHERE ${where}`).get(...params);
    const itens = db.prepare(`SELECT t.*, u.nome AS usuario_nome,
        cp.numero || '-' || cp.digito AS contraparte_conta, clp.nome AS contraparte_nome
      FROM transacoes t
      LEFT JOIN usuarios u ON u.id = t.usuario_id
      LEFT JOIN contas cp ON cp.id = t.contraparte_conta_id
      LEFT JOIN clientes clp ON clp.id = cp.cliente_id
      WHERE ${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
    res.json({ conta, itens, total: resumo.total, entradas_centavos: resumo.entradas_centavos, saidas_centavos: resumo.saidas_centavos, pagina, limite });
  });

  r.post('/', alcada(db, 'contas.abrir'), (req, res) => {
    const { cliente_id, tipo, limite_centavos = 0 } = req.body ?? {};
    v.exigir(TIPOS.includes(tipo), 'Tipo de conta inválido.');
    const limite = Number(limite_centavos);
    v.exigir(Number.isInteger(limite) && limite >= 0, 'Limite inválido.');
    v.exigir(tipo !== 'poupanca' || limite === 0, 'Conta poupança não possui limite.');
    if (limite > 0) alcadas.exigirValor(db, req, 'contas.limite', limite);
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(cliente_id);
    v.exigir(cliente, 'Cliente não encontrado.');
    if (cliente.status !== 'ativo') throw new ErroNegocio('Só é possível abrir conta para clientes ativos.', 409);
    const id = transacao(db, () => {
      const { agencia, numero, digito } = proximoNumero(db);
      const ins = db.prepare('INSERT INTO contas (cliente_id, tipo, agencia, numero, digito, limite_centavos) VALUES (?, ?, ?, ?, ?, ?)')
        .run(cliente.id, tipo, agencia, numero, digito, limite);
      const novoId = Number(ins.lastInsertRowid);
      registrar(db, req, 'abrir', 'conta', novoId, { cliente: cliente.nome, tipo, agencia, numero: `${numero}-${digito}` });
      return novoId;
    });
    res.status(201).json(buscarConta(db, id));
  });

  r.patch('/:id/limite', alcada(db, 'contas.limite'), (req, res) => {
    const conta = buscarConta(db, req.params.id);
    const limite = Number(req.body?.limite_centavos);
    v.exigir(Number.isInteger(limite) && limite >= 0, 'Limite inválido.');
    v.exigir(conta.tipo !== 'poupanca' || limite === 0, 'Conta poupança não possui limite.');
    v.exigir(conta.status !== 'encerrada', 'Conta encerrada.');
    alcadas.exigirValor(db, req, 'contas.limite', limite);
    v.exigir(conta.saldo_centavos >= -limite, 'O novo limite é menor que o saldo devedor atual.');
    db.prepare('UPDATE contas SET limite_centavos = ? WHERE id = ?').run(limite, conta.id);
    registrar(db, req, 'alterar_limite', 'conta', conta.id, { de: conta.limite_centavos, para: limite });
    res.json(buscarConta(db, conta.id));
  });

  // Bloqueio, desbloqueio e encerramento: vão para a Ouvidoria quando a regra exige análise (tela Alçadas).
  r.patch('/:id/status', alcada(db, 'contas.status'), (req, res) => {
    const conta = buscarConta(db, req.params.id);
    const { status, motivo } = req.body ?? {};
    situacao.validarStatusConta(db, conta, status);
    const acao = situacao.acaoConta(status);
    if (ouvidoria.exigeAnalise(db, acao)) {
      const s = transacao(db, () => ouvidoria.criar(db, req, { tipo: acao, clienteId: conta.cliente_id, contaId: conta.id, dados: { status }, motivo, origem: 'equipe' }));
      return res.status(202).json({ em_analise: true, solicitacao: s });
    }
    res.json(transacao(db, () => situacao.alterarStatusConta(db, req, conta.id, status, { motivo: v.texto(motivo) })));
  });

  return r;
};
