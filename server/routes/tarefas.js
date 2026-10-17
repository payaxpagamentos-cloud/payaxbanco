'use strict';

const { Router } = require('express');
const { filtroCarteira, empresaPermitida } = require('../lib/acesso');
const { concluirTarefa } = require('../lib/carteira');
const { naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hoje, somarDias } = require('../lib/datas');
const v = require('../lib/validacao');

const RECORRENCIAS = ['nenhuma', 'semanal', 'mensal'];

module.exports = (db) => {
  const r = Router();
  const permitida = (req) => (empresaId) => empresaPermitida(db, req.usuario, empresaId);

  r.get('/', (req, res) => {
    const f = filtroCarteira(req.usuario);
    const filtros = [f.sql];
    const params = [...f.params];
    const dia = hoje();
    const status = req.query.status ?? 'aberta';
    if (status !== 'todas') { filtros.push('t.status = ?'); params.push(status); }
    if (req.query.empresa_id) { filtros.push('t.empresa_id = ?'); params.push(Number(req.query.empresa_id)); }
    if (req.query.responsavel_id) { filtros.push('t.responsavel_id = ?'); params.push(Number(req.query.responsavel_id)); }
    if (req.query.prazo === 'atrasadas') { filtros.push('t.vencimento < ?'); params.push(dia); }
    if (req.query.prazo === 'hoje') { filtros.push('t.vencimento = ?'); params.push(dia); }
    if (req.query.prazo === 'semana') { filtros.push('t.vencimento BETWEEN ? AND ?'); params.push(dia, somarDias(dia, 7)); }
    res.json(db.prepare(`SELECT t.*, COALESCE(e.nome_fantasia, e.razao_social) AS empresa_nome, u.nome AS responsavel_nome, c.nome AS concluida_por_nome
      FROM tarefas t JOIN empresas e ON e.id = t.empresa_id LEFT JOIN usuarios u ON u.id = t.responsavel_id LEFT JOIN usuarios c ON c.id = t.concluida_por
      WHERE ${filtros.join(' AND ')} ORDER BY t.status = 'aberta' DESC, t.vencimento, t.id LIMIT 500`).all(...params));
  });

  const dados = (db2, corpo, atual = {}) => {
    const d = { ...atual, ...corpo };
    const titulo = v.texto(d.titulo, 160);
    v.exigir(titulo, 'Informe o título.');
    v.exigir(RECORRENCIAS.includes(d.recorrencia ?? 'nenhuma'), 'Recorrência inválida.');
    const resp = v.id(d.responsavel_id);
    if (resp) v.exigir(db2.prepare('SELECT 1 FROM usuarios WHERE id = ? AND ativo = 1').get(resp), 'Responsável não encontrado.');
    return { titulo, descricao: v.texto(d.descricao, 2000), responsavel_id: resp, vencimento: v.data(d.vencimento, 'o prazo'), recorrencia: d.recorrencia ?? 'nenhuma' };
  };

  r.post('/', (req, res) => {
    const empresa = empresaPermitida(db, req.usuario, req.body.empresa_id);
    const d = dados(db, req.body);
    const x = db.prepare('INSERT INTO tarefas (empresa_id, titulo, descricao, responsavel_id, vencimento, recorrencia) VALUES (?, ?, ?, ?, ?, ?)')
      .run(empresa.id, d.titulo, d.descricao, d.responsavel_id, d.vencimento, d.recorrencia);
    registrar(db, req, 'tarefa_criada', { id: Number(x.lastInsertRowid), titulo: d.titulo }, empresa.id);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });

  const carregar = (req) => {
    const t = db.prepare('SELECT * FROM tarefas WHERE id = ?').get(Number(req.params.id));
    if (!t) throw naoEncontrado('Tarefa');
    empresaPermitida(db, req.usuario, t.empresa_id);
    return t;
  };

  r.patch('/:id', (req, res) => {
    const t = carregar(req);
    v.exigir(t.status === 'aberta', 'Só tarefas abertas podem ser alteradas.');
    const d = dados(db, req.body, t);
    db.prepare('UPDATE tarefas SET titulo = ?, descricao = ?, responsavel_id = ?, vencimento = ?, recorrencia = ? WHERE id = ?')
      .run(d.titulo, d.descricao, d.responsavel_id, d.vencimento, d.recorrencia, t.id);
    res.status(204).end();
  });

  r.post('/:id/concluir', (req, res) => {
    const r2 = concluirTarefa(db, req, req.params.id, permitida(req));
    const t = db.prepare('SELECT empresa_id, titulo FROM tarefas WHERE id = ?').get(Number(req.params.id));
    registrar(db, req, 'tarefa_concluida', { id: Number(req.params.id), titulo: t.titulo }, t.empresa_id);
    res.json(r2);
  });

  r.post('/:id/cancelar', (req, res) => {
    const t = carregar(req);
    v.exigir(t.status === 'aberta', 'A tarefa não está aberta.');
    db.prepare("UPDATE tarefas SET status = 'cancelada' WHERE id = ?").run(t.id);
    registrar(db, req, 'tarefa_cancelada', { id: t.id, titulo: t.titulo }, t.empresa_id);
    res.status(204).end();
  });

  return r;
};
