'use strict';

/*
 * Pedidos de abertura de conta feitos no site, para a equipe analisar (Backoffice → Abertura de contas).
 * Abrir um documento fica na auditoria: é dado pessoal de terceiro.
 */
const express = require('express');
const { exigir } = require('../auth');
const auditoria = require('../lib/auditoria');
const abertura = require('../lib/abertura');
const { listaPaginada } = require('../lib/http');
const { corpoCliente } = require('./clientes');

const validarCadastro = (d) => corpoCliente(d, { novo: true });

module.exports = (db) => {
  const r = express.Router();

  r.get('/', exigir('aberturas.ver'), (req, res) => {
    const cond = [];
    const p = [];
    if (req.query.situacao) { cond.push('s.situacao = ?'); p.push(String(req.query.situacao)); }
    if (req.query.busca) {
      const d = String(req.query.busca).replace(/\D/g, '');
      cond.push(`(s.razao_social LIKE ? OR s.cnpj LIKE ?)`);
      p.push(`%${String(req.query.busca).replace(/[%_]/g, '')}%`, `%${d || '@'}%`);
    }
    const sql = `SELECT s.*, u.nome AS analisado_por_nome FROM solicitacoes_abertura s LEFT JOIN usuarios u ON u.id = s.analisado_por
      ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY CASE s.situacao WHEN 'nova' THEN 0 WHEN 'em_analise' THEN 1 ELSE 2 END, s.id DESC`;
    const lista = listaPaginada(db, sql, p, req.query);
    const contagem = Object.fromEntries(db.prepare('SELECT situacao, COUNT(*) AS n FROM solicitacoes_abertura GROUP BY situacao').all().map((x) => [x.situacao, x.n]));
    res.json({ ...lista, itens: lista.itens.map(abertura.formatar), contagem });
  });

  r.get('/:id', exigir('aberturas.ver'), (req, res) => res.json(abertura.formatar(abertura.buscar(db, req.params.id))));

  r.get('/:id/arquivo/:indice', exigir('aberturas.ver'), (req, res) => {
    const a = abertura.arquivo(db, req.params.id, req.params.indice);
    auditoria.registrar(db, req, { acao: 'abertura.documento_aberto', entidade: 'abertura', entidade_id: Number(req.params.id), depois: { documento: a.nome } });
    res.set('Content-Type', a.mime);
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(a.nome)}"`);
    res.set('Cache-Control', 'no-store');
    res.sendFile(a.caminho);
  });

  r.post('/:id/analisar', exigir('aberturas.ver'), (req, res) => {
    const s = abertura.emAnalise(db, req.params.id, req.usuario);
    auditoria.registrar(db, req, { acao: 'abertura.em_analise', entidade: 'abertura', entidade_id: s.id });
    res.json(s);
  });

  r.post('/:id/aprovar', exigir('aberturas.aprovar'), (req, res) => {
    const out = abertura.aprovar(db, req.params.id, req.usuario, { validarCadastro });
    auditoria.registrar(db, req, { acao: 'abertura.aprovada', entidade: 'abertura', entidade_id: Number(req.params.id), cliente_id: out.cliente_id,
      depois: { cliente_id: out.cliente_id, acesso: out.acesso?.email ?? null } });
    if (out.acesso) {
      auditoria.registrar(db, req, { acao: 'acesso.criado', entidade: 'usuario_cliente', entidade_id: out.acesso.id, cliente_id: out.cliente_id,
        depois: { nome: out.acesso.nome, email: out.acesso.email, perfil: 'admin' } });
    }
    res.json(out);
  });

  r.post('/:id/recusar', exigir('aberturas.aprovar'), (req, res) => {
    const s = abertura.recusar(db, req.params.id, req.body?.motivo, req.usuario);
    auditoria.registrar(db, req, { acao: 'abertura.recusada', entidade: 'abertura', entidade_id: s.id, depois: { motivo: s.motivo } });
    res.json(s);
  });

  return r;
};
