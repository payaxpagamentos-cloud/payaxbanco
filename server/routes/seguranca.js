'use strict';

const fs = require('node:fs');
const { Router } = require('express');
const config = require('../config');
const { registrar } = require('../lib/auditoria');
const backup = require('../lib/backup');
const dois = require('../lib/doisfatores');
const { naoEncontrado } = require('../lib/erros');

/** Segurança (administrador): 2FA obrigatória, situação da 2FA da equipe, backups. */
module.exports = (db) => {
  const r = Router();

  r.get('/', (_req, res) => {
    const arquivos = fs.existsSync(config.arquivosDir) ? fs.readdirSync(config.arquivosDir, { recursive: true }).length : 0;
    res.json({
      exigir_2fa_equipe: dois.exigidaEquipe(db),
      usuarios: db.prepare('SELECT id, nome, email, perfil, ativo, totp_ativo, ultimo_acesso FROM usuarios ORDER BY ativo DESC, nome').all(),
      portal: db.prepare(`SELECT r.id, r.nome, r.email, r.totp_ativo, r.ultimo_acesso, COALESCE(e.nome_fantasia, e.razao_social) AS empresa
        FROM responsaveis r JOIN empresas e ON e.id = r.empresa_id WHERE r.acesso_portal = 1 AND r.ativo = 1 ORDER BY e.razao_social, r.nome`).all(),
      backups: backup.listar(),
      backup_intervalo_horas: config.backupIntervaloHoras,
      backup_manter: config.backupManter,
      documentos_armazenados: arquivos,
      falhas_login_24h: db.prepare("SELECT COUNT(*) AS n FROM auditoria WHERE acao IN ('login_falhou','login_2fa_falhou','portal_login_falhou') AND criado_em >= datetime('now', '-1 day')").get().n,
    });
  });

  r.patch('/config', (req, res) => {
    const exigir = Boolean(req.body.exigir_2fa_equipe);
    db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('exigir_2fa_equipe', ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor").run(exigir ? '1' : '0');
    registrar(db, req, 'seguranca_configurada', { exigir_2fa_equipe: exigir });
    res.status(204).end();
  });

  r.post('/usuarios/:id/reset-2fa', (req, res) => {
    const x = db.prepare('UPDATE usuarios SET totp_ativo = 0, totp_segredo = NULL, totp_ultimo_passo = NULL WHERE id = ?').run(Number(req.params.id));
    if (!x.changes) throw naoEncontrado('Usuário');
    registrar(db, req, 'usuario_2fa_redefinida', { id: Number(req.params.id) });
    res.status(204).end();
  });

  r.post('/backups', (req, res) => {
    const b = backup.gerar(db);
    registrar(db, req, 'backup_manual', b);
    res.status(201).json(b);
  });
  r.get('/backups/:nome', (req, res) => {
    const p = backup.caminho(req.params.nome);
    if (!p) throw naoEncontrado('Backup');
    registrar(db, req, 'backup_baixado', { nome: req.params.nome });
    res.download(p, req.params.nome);
  });

  return r;
};
