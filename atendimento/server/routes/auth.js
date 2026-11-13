'use strict';

const express = require('express');
const { agora, auditar } = require('../db');
const { emitirToken } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { hashSenha, verificarSenha } = require('../lib/senha');
const v = require('../lib/validacao');

module.exports = function rotasAuth(db, autenticado) {
  const r = express.Router();

  const recusar = (email, ip, motivo) => {
    db.prepare('INSERT INTO acessos_recusados (email, ip, motivo, criado_em) VALUES (?, ?, ?, ?)').run(email ?? null, ip ?? null, motivo, agora());
  };

  const permissoes = require('../lib/permissoes');
  const comoSessao = (u) => ({
    token: emitirToken(u),
    usuario: {
      id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, empresa_id: u.empresa_id,
      empresa_nome: u.empresa_nome ?? null, disponivel: Boolean(u.disponivel), max_simultaneas: u.max_simultaneas,
      // O painel desenha o menu e os botões a partir daqui. É conveniência de tela:
      // quem decide de verdade é a rota, que confere a mesma permissão no servidor.
      permissoes: [...permissoes.efetivas(db, u)],
    },
  });

  r.post('/login', (req, res, next) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const senha = String(req.body?.senha ?? '');
      const u = db.prepare(`SELECT u.*, e.nome AS empresa_nome, e.status AS empresa_status FROM usuarios u
        LEFT JOIN empresas e ON e.id = u.empresa_id WHERE u.email = ? COLLATE NOCASE`).get(email);
      // Mesma mensagem para e-mail inexistente e senha errada: não conta quem existe.
      if (!u || !verificarSenha(senha, u.senha_hash)) {
        recusar(email, req.ip, 'e-mail ou senha incorretos');
        throw new ErroNegocio('E-mail ou senha incorretos.', 401);
      }
      if (!u.ativo) { recusar(email, req.ip, 'usuário inativo'); throw new ErroNegocio('Usuário inativo. Fale com o administrador.', 401); }
      if (u.empresa_id && u.empresa_status !== 'ativa') { recusar(email, req.ip, 'empresa bloqueada'); throw new ErroNegocio('Empresa bloqueada. Fale com o suporte.', 401); }
      db.prepare('UPDATE usuarios SET ultimo_acesso = ?, visto_em = ? WHERE id = ?').run(agora(), agora(), u.id);
      auditar(db, { usuario: u, acao: 'entrou no painel', ip: req.ip });
      res.json(comoSessao(u));
    } catch (err) { next(err); }
  });

  r.get('/eu', autenticado, (req, res) => res.json(comoSessao(req.usuario)));

  r.post('/senha', autenticado, (req, res, next) => {
    try {
      const atual = String(req.body?.atual ?? '');
      const nova = v.senha(req.body?.nova);
      const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuario.id);
      if (!verificarSenha(atual, u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 401);
      if (atual === nova) throw new ErroNegocio('A nova senha precisa ser diferente da atual.');
      db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(nova), u.id);
      auditar(db, { usuario: req.usuario, acao: 'alterou a própria senha', ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  /** O atendente liga e desliga a própria disponibilidade (entra e sai da distribuição). */
  r.post('/disponivel', autenticado, (req, res, next) => {
    try {
      const u = req.usuario;
      if (!['atendente', 'cliente'].includes(u.perfil)) throw new ErroNegocio('Só atendentes entram na distribuição de conversas.', 403);
      const disponivel = v.booleano(req.body?.disponivel) ? 1 : 0;
      db.prepare('UPDATE usuarios SET disponivel = ?, visto_em = ? WHERE id = ?').run(disponivel, agora(), u.id);
      // Ao ficar disponível, já recebe o que está esperando na fila.
      const entregues = disponivel ? require('../lib/filas').girarFila(db, u.empresa_id) : [];
      res.json({ disponivel: Boolean(disponivel), recebidas: entregues.filter((e) => e.atendente_id === u.id).length });
    } catch (err) { next(err); }
  });

  return r;
};
