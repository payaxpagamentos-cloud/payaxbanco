'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { permitir } = require('../auth');
const { hashSenha } = require('../lib/senha');
const { naoEncontrado } = require('../lib/erros');
const { registrar, diferencas } = require('../lib/auditoria');
const v = require('../lib/validacao');

const CAMPOS = 'id, empresa_id, nome, cargo, email, telefone, recebe_relatorios, acesso_portal, pode_aprovar, limite_aprovacao_centavos, totp_ativo, ativo, ultimo_acesso, precisa_trocar_senha, criado_em';

/** Senha provisória legível (sem 0/O, 1/l), mostrada uma única vez. */
const senhaProvisoria = () => Array.from(crypto.randomBytes(10), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'[b % 54]).join('');

/**
 * Responsáveis na empresa cliente. Quem cria, altera ou dá acesso ao Portal é supervisor ou
 * administrador: um aprovador do Portal autoriza pagamentos, então não pode ser criado por quem lança.
 */
module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;
  const gestor = permitir('admin', 'supervisor');

  r.get('/', (req, res) => res.json(db.prepare(`SELECT ${CAMPOS} FROM responsaveis WHERE empresa_id = ? ORDER BY ativo DESC, nome`).all(eid(req))));

  const dados = (b, atual = {}) => {
    const d = { ...atual, ...b };
    const nome = v.texto(d.nome, 120);
    v.exigir(nome, 'Informe o nome.');
    const email = v.texto(d.email, 120);
    v.exigir(!email || v.emailValido(email), 'E-mail inválido.');
    const portal = d.acesso_portal ? 1 : 0;
    v.exigir(!portal || email, 'Para acessar o Portal, informe o e-mail.');
    const limite = Number(d.limite_aprovacao_centavos ?? -1);
    v.exigir(Number.isInteger(limite) && limite >= -1, 'Limite de aprovação inválido.');
    return { nome, cargo: v.texto(d.cargo, 80), email, telefone: v.digitos(d.telefone) || null, recebe_relatorios: d.recebe_relatorios ? 1 : 0,
      acesso_portal: portal, pode_aprovar: portal && d.pode_aprovar ? 1 : 0, limite_aprovacao_centavos: limite, ativo: d.ativo === undefined ? 1 : d.ativo ? 1 : 0 };
  };

  r.post('/', gestor, (req, res) => {
    const d = dados(req.body);
    const senha = d.acesso_portal ? senhaProvisoria() : null;
    const x = db.prepare(`INSERT INTO responsaveis (empresa_id, nome, cargo, email, telefone, recebe_relatorios, acesso_portal, senha_hash, pode_aprovar, limite_aprovacao_centavos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(eid(req), d.nome, d.cargo, d.email, d.telefone, d.recebe_relatorios, d.acesso_portal, senha && hashSenha(senha), d.pode_aprovar, d.limite_aprovacao_centavos);
    registrar(db, req, 'responsavel_criado', { id: Number(x.lastInsertRowid), nome: d.nome, acesso_portal: d.acesso_portal, pode_aprovar: d.pode_aprovar }, eid(req));
    res.status(201).json({ id: Number(x.lastInsertRowid), senha_provisoria: senha });
  });

  const carregar = (req) => {
    const x = db.prepare('SELECT * FROM responsaveis WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), eid(req));
    if (!x) throw naoEncontrado('Responsável');
    return x;
  };

  r.patch('/:id', gestor, (req, res) => {
    const atual = carregar(req);
    const d = dados(req.body, atual);
    // Ganhou acesso agora: gera a senha provisória.
    const senha = d.acesso_portal && !atual.senha_hash ? senhaProvisoria() : null;
    db.prepare(`UPDATE responsaveis SET nome = ?, cargo = ?, email = ?, telefone = ?, recebe_relatorios = ?, acesso_portal = ?, pode_aprovar = ?,
      limite_aprovacao_centavos = ?, ativo = ?, senha_hash = COALESCE(?, senha_hash), precisa_trocar_senha = CASE WHEN ? IS NULL THEN precisa_trocar_senha ELSE 1 END WHERE id = ?`)
      .run(d.nome, d.cargo, d.email, d.telefone, d.recebe_relatorios, d.acesso_portal, d.pode_aprovar, d.limite_aprovacao_centavos, d.ativo,
        senha && hashSenha(senha), senha, atual.id);
    registrar(db, req, 'responsavel_alterado', { id: atual.id, alteracoes: diferencas(atual, d) }, eid(req));
    res.json({ senha_provisoria: senha });
  });

  r.post('/:id/nova-senha', gestor, (req, res) => {
    const x = carregar(req);
    v.exigir(x.acesso_portal, 'Este responsável não tem acesso ao Portal.');
    const senha = senhaProvisoria();
    db.prepare('UPDATE responsaveis SET senha_hash = ?, precisa_trocar_senha = 1 WHERE id = ?').run(hashSenha(senha), x.id);
    registrar(db, req, 'responsavel_senha_redefinida', { id: x.id }, eid(req));
    res.json({ senha_provisoria: senha });
  });

  r.post('/:id/reset-2fa', gestor, (req, res) => {
    const x = carregar(req);
    db.prepare('UPDATE responsaveis SET totp_ativo = 0, totp_segredo = NULL, totp_ultimo_passo = NULL WHERE id = ?').run(x.id);
    registrar(db, req, 'responsavel_2fa_redefinida', { id: x.id }, eid(req));
    res.status(204).end();
  });

  return r;
};
