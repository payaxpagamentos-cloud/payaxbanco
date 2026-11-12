'use strict';

const { Router } = require('express');
const { lerChaveTerminal } = require('../lib/contas');
const { proximaPendente, resultado, buscar } = require('../lib/maquininha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');

/**
 * API das maquininhas de cartão (sem usuário: a chave do terminal identifica a empresa e o aparelho).
 * Cabeçalho: X-Api-Key: pdv_<prefixo>_<segredo>
 *
 * Fluxo do modo "agente" (aplicativo instalado na maquininha):
 *   1. GET  /api/integracao/terminal            → confere a chave e mostra o aparelho
 *   2. GET  /api/integracao/terminal/cobranca   → próxima cobrança a passar no cartão (204 quando não há nada)
 *   3. POST /api/integracao/terminal/resultado  → { referencia, status: aprovada|negada|cancelada, nsu, autorizacao, bandeira, cartao_final }
 * No modo "webhook", o PDV chama o adquirente e o retorno chega no mesmo POST /resultado.
 */
module.exports = (db) => {
  const r = Router();

  r.use((req, _res, next) => {
    const chave = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const achado = lerChaveTerminal(db, chave);
    if (!achado) return next(new ErroNegocio('Chave da maquininha inválida ou revogada.', 401));
    req.terminal = achado.terminal;
    req.empresa = achado.empresa;
    next();
  });

  r.get('/terminal', (req, res) => res.json({
    terminal: { id: req.terminal.id, nome: req.terminal.nome, adquirente: req.terminal.adquirente, modelo: req.terminal.modelo, modo: req.terminal.modo },
    empresa: { id: req.empresa.id, nome: req.empresa.nome },
  }));

  r.get('/terminal/cobranca', (req, res) => {
    const t = proximaPendente(db, req.terminal);
    if (!t) return res.status(204).end();
    res.json(t);
  });

  r.post('/terminal/resultado', (req, res) => {
    const t = resultado(db, req.terminal, req.body);
    registrar(db, { usuario: null, ip: req.ip }, 'cartao_resultado', { terminal: req.terminal.id, referencia: t.referencia, status: t.status }, req.empresa.id);
    res.json(t);
  });

  r.get('/terminal/cobranca/:id', (req, res) => {
    const t = buscar(db, req.empresa.id, req.params.id);
    if (t.terminal_id !== req.terminal.id) throw new ErroNegocio('Cobrança de outra maquininha.', 403);
    res.json(t);
  });

  return r;
};
