'use strict';

const { Router } = require('express');
const { permitir } = require('../auth');
const { registrar } = require('../lib/auditoria');
const integ = require('../lib/integracoes');
const nfe = require('../lib/nfe');
const v = require('../lib/validacao');

const celula = (x) => {
  let s = String(x ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;
  const gestor = permitir('admin', 'supervisor');

  r.get('/chaves', (req, res) => res.json(db.prepare(`SELECT c.id, c.nome, c.prefixo, c.ultimo_uso, c.revogada_em, c.criado_em, u.nome AS criado_por_nome
    FROM chaves_api c LEFT JOIN usuarios u ON u.id = c.criado_por WHERE c.empresa_id = ? ORDER BY c.revogada_em IS NOT NULL, c.id DESC`).all(eid(req))));
  r.post('/chaves', gestor, (req, res) => {
    const c = integ.criarChave(db, req, eid(req), req.body.nome);
    registrar(db, req, 'chave_api_criada', { prefixo: c.prefixo, nome: req.body.nome }, eid(req));
    res.status(201).json(c);
  });
  r.delete('/chaves/:id', gestor, (req, res) => {
    const x = db.prepare("UPDATE chaves_api SET revogada_em = datetime('now') WHERE id = ? AND empresa_id = ? AND revogada_em IS NULL").run(Number(req.params.id), eid(req));
    v.exigir(x.changes, 'Chave não encontrada ou já revogada.');
    registrar(db, req, 'chave_api_revogada', { id: Number(req.params.id) }, eid(req));
    res.status(204).end();
  });

  // Importação de lançamentos exportados de um sistema de gestão (CSV).
  r.post('/lancamentos/importar', (req, res) => {
    v.exigir(typeof req.body.conteudo === 'string', 'Arquivo vazio.');
    const ids = integ.criarEmLote(db, req, eid(req), integ.lerCsvLancamentos(req.body.conteudo));
    registrar(db, req, 'lancamentos_importados', { quantidade: ids.length, arquivo: req.body.arquivo }, eid(req));
    res.status(201).json({ importados: ids.length });
  });

  // NF-e (XML): prévia e lançamento em contas a pagar ou a receber, com o XML anexado.
  r.post('/nfe', (req, res) => {
    v.exigir(typeof req.body.conteudo === 'string', 'Envie o XML da NF-e.');
    const r2 = nfe.importar(db, req, req.empresa, req.body);
    if (!req.body.previa) registrar(db, req, 'nfe_importada', { chave: r2.chave, ids: r2.ids, tipo: r2.tipo }, eid(req));
    res.status(req.body.previa ? 200 : 201).json(r2);
  });

  r.get('/contabil', (req, res) => {
    const x = integ.exportacaoContabil(db, eid(req), req.query.de, req.query.ate);
    res.json({ quantidade: x.linhas.length, sem_codigo: x.sem_codigo, amostra: x.linhas.slice(0, 20) });
  });
  r.get('/contabil.csv', (req, res) => {
    const x = integ.exportacaoContabil(db, eid(req), req.query.de, req.query.ate);
    const linhas = [['Data', 'Conta débito', 'Conta crédito', 'Valor', 'Histórico'],
      ...x.linhas.map((l) => [l.data.split('-').reverse().join('/'), l.debito, l.credito, (l.valor_centavos / 100).toFixed(2).replace('.', ','), l.historico])];
    registrar(db, req, 'exportacao_contabil', { de: req.query.de, ate: req.query.ate, linhas: x.linhas.length }, eid(req));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="contabil-${req.empresa.cnpj}-${req.query.de}-${req.query.ate}.csv"` });
    res.send(`﻿${linhas.map((l) => l.map(celula).join(';')).join('\r\n')}\r\n`);
  });
  return r;
};
