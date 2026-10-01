'use strict';

const { Router } = require('express');
const rel = require('../lib/relacionamento');
const { alcada } = require('../lib/alcadas');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');

/**
 * Relacionamento no Banqueiro. O gerente vê só a própria carteira; o administrador vê todos os gerentes
 * (filtro opcional ?gerente_id=, e "atendimento" para conversas de clientes sem gerente).
 */
module.exports = (db) => {
  const r = Router();
  const atender = alcada(db, 'relacionamento.atender');

  /** Gerente cujos dados a requisição pode ver: undefined = todos (só administrador). */
  function escopo(req) {
    if (req.usuario.perfil !== 'admin') return req.usuario.id;
    const g = req.query.gerente_id ?? req.body?.gerente_id;
    if (g === 'atendimento' || g === null) return null;
    return g === undefined || g === '' ? undefined : Number(g);
  }

  // Lista de gerentes (para escolher o gerente de uma conta): qualquer pessoa da equipe.
  r.get('/gerentes', (_req, res) => res.json(rel.listarGerentes(db)));

  r.get('/painel', atender, (req, res) => res.json(rel.painel(db, escopo(req), req.query.dias)));

  r.get('/pendentes', atender, (req, res) => {
    const g = escopo(req);
    const where = g === undefined ? '' : g === null ? 'AND gerente_id IS NULL' : 'AND gerente_id = ?';
    res.json({ total: db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE autor = 'cliente' AND lida_em IS NULL ${where}`).get(...(g ? [g] : [])).n });
  });

  r.get('/conversas', atender, (req, res) => res.json(rel.conversas(db, escopo(req))));

  r.get('/carteira', atender, (req, res) => res.json(rel.carteira(db, escopo(req))));

  /** Gerente da conversa: o próprio usuário; o administrador informa qual (ou "atendimento"). */
  function gerenteDaConversa(req) {
    const g = escopo(req);
    if (g === undefined) throw new ErroNegocio('Informe o gerente da conversa.', 422);
    return g;
  }

  r.get('/conversas/:clienteId', atender, (req, res) => {
    const gerenteId = gerenteDaConversa(req);
    const cliente = rel.cliente(db, req.params.clienteId);
    if (req.usuario.perfil !== 'admin' && !rel.naCarteira(db, cliente.id, gerenteId)) throw new ErroNegocio('Este cliente não está na sua carteira.', 403);
    rel.marcarLidas(db, cliente.id, gerenteId, 'gerente');
    res.json({ cliente, gerente_id: gerenteId, mensagens: rel.mensagens(db, cliente.id, gerenteId) });
  });

  r.post('/conversas/:clienteId', atender, (req, res) => {
    const gerenteId = gerenteDaConversa(req);
    const cliente = rel.cliente(db, req.params.clienteId);
    if (req.usuario.perfil !== 'admin' && !rel.naCarteira(db, cliente.id, gerenteId)) throw new ErroNegocio('Este cliente não está na sua carteira.', 403);
    const m = rel.enviar(db, { clienteId: cliente.id, gerenteId, autor: 'gerente', usuarioId: req.usuario.id, texto: req.body?.texto });
    rel.marcarLidas(db, cliente.id, gerenteId, 'gerente');
    registrar(db, req, 'mensagem_enviada', 'cliente', cliente.id, { gerente_id: gerenteId });
    res.status(201).json(m);
  });

  return r;
};
