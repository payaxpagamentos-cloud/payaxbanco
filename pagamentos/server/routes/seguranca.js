'use strict';

/* Backups do banco e autenticação em duas etapas da equipe e dos acessos dos clientes. */
const fs = require('node:fs');
const express = require('express');
const config = require('../config');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { exigir } = require('../auth');
const v = require('../lib/validacao');
const backup = require('../lib/backup');
const dois = require('../lib/doisfatores');
const auditoria = require('../lib/auditoria');

module.exports = (db) => {
  const r = express.Router();

  r.get('/', exigir('auditoria.ver', '*'), (_req, res) => {
    res.json({
      backups: { ...backup.situacao(db), historico: backup.listar(db) },
      exigir_2fa_equipe: dois.exigidaEquipe(db),
      equipe: db.prepare('SELECT id, nome, email, perfil, ativo, totp_ativo, ultimo_acesso FROM usuarios ORDER BY ativo DESC, nome').all(),
      acessos_clientes: db.prepare(`SELECT uc.id, uc.nome, uc.email, uc.ativo, uc.totp_ativo, uc.ultimo_acesso,
          COALESCE(c.nome_fantasia, c.razao_social) AS cliente
        FROM usuarios_cliente uc JOIN clientes c ON c.id = uc.cliente_id ORDER BY c.razao_social, uc.nome`).all(),
      logins_recusados_24h: db.prepare(`SELECT COUNT(*) AS n FROM auditoria
        WHERE acao IN ('login.recusado', 'login.2fa.recusado') AND criado_em >= datetime('now', '-1 day')`).get().n,
      sem_2fa: db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE ativo = 1 AND totp_ativo = 0").get().n,
    });
  });

  /** Backup manual, já conferido. */
  r.post('/backups', exigir('*'), (req, res) => {
    const out = backup.gerar(db, { usuario: req.usuario, automatico: false });
    auditoria.registrar(db, req, { acao: 'backup.gerado', entidade: 'backup', depois: { nome: out.nome, confere: out.confere } });
    if (!out.confere) throw new ErroNegocio(`O backup foi gerado mas NÃO conferiu: ${out.divergencia}`, 500);
    res.status(201).json(out);
  });

  /** Download do arquivo. Fica registrado: é uma cópia do razão saindo do servidor. */
  r.get('/backups/:nome', exigir('*'), (req, res) => {
    const caminho = backup.caminho(req.params.nome);
    if (!caminho) throw naoEncontrado('Backup');
    auditoria.registrar(db, req, { acao: 'backup.baixado', entidade: 'backup', depois: { nome: req.params.nome } });
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' });
    res.attachment(req.params.nome);
    fs.createReadStream(caminho).pipe(res);
  });

  r.put('/exigir-2fa', exigir('*'), (req, res) => {
    const exigirAgora = v.booleano(req.body?.exigir);
    // Não deixa trancar a porta com a chave dentro: o administrador precisa do próprio 2FA ativo.
    if (exigirAgora && !db.prepare('SELECT totp_ativo FROM usuarios WHERE id = ?').get(req.usuario.id).totp_ativo) {
      throw new ErroNegocio('Ative a sua própria autenticação em duas etapas antes de exigi-la da equipe.', 422);
    }
    dois.definirExigencia(db, exigirAgora);
    auditoria.registrar(db, req, { acao: 'seguranca.2fa.exigencia', depois: { exigir: exigirAgora } });
    res.json({ exigir_2fa_equipe: dois.exigidaEquipe(db) });
  });

  /** Redefine o 2FA de quem perdeu o celular. */
  r.post('/equipe/:id/redefinir-2fa', exigir('*'), (req, res) => {
    dois.redefinir(db, 'equipe', Number(req.params.id));
    auditoria.registrar(db, req, { acao: '2fa.redefinida', entidade: 'usuario', entidade_id: Number(req.params.id) });
    res.json({ ok: true });
  });

  r.post('/acessos/:id/redefinir-2fa', exigir('*', 'acessos.gerenciar'), (req, res) => {
    const a = db.prepare('SELECT cliente_id FROM usuarios_cliente WHERE id = ?').get(Number(req.params.id));
    if (!a) throw naoEncontrado('Acesso');
    dois.redefinir(db, 'cliente', Number(req.params.id));
    auditoria.registrar(db, req, { acao: 'cliente.2fa.redefinida', entidade: 'usuario_cliente', entidade_id: Number(req.params.id), cliente_id: a.cliente_id });
    res.json({ ok: true });
  });

  return r;
};
