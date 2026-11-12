'use strict';

const { Router } = require('express');
const maquininha = require('../lib/maquininha');
const { caixaDoOperador } = require('../lib/caixa');
const { permitir } = require('../auth');
const { registrar } = require('../lib/auditoria');

const OPERA = ['master', 'suporte', 'admin', 'operador'];

/**
 * Cobranças na maquininha (/api/empresas/:eid/cartao). O PDV cria a cobrança, a maquininha responde
 * (pela API de integração ou pelo adquirente) e o painel acompanha até aprovar, negar ou expirar.
 */
module.exports = (db) => {
  const r = Router({ mergeParams: true });

  r.post('/cobrancas', permitir(...OPERA), async (req, res) => {
    const caixa = caixaDoOperador(db, req.empresa.id, req.usuario.id);
    const t = await maquininha.cobrar(db, {
      empresa: req.empresa,
      terminalId: req.body.terminal_id,
      forma: req.body.forma,
      valorCentavos: req.body.valor_centavos,
      parcelas: req.body.parcelas ?? 1,
      operadorId: req.usuario.id,
      caixaId: caixa?.id ?? null,
    });
    registrar(db, req, 'cartao_cobranca', { transacao: t.id, terminal: t.terminal_id, valor: t.valor_centavos, forma: t.forma });
    res.status(201).json(t);
  });

  // Maquininha sem integração: o operador digita o que está no comprovante do aparelho.
  r.post('/cobrancas/manual', permitir(...OPERA), (req, res) => {
    const caixa = caixaDoOperador(db, req.empresa.id, req.usuario.id);
    const t = maquininha.registrarManual(db, {
      empresa: req.empresa,
      terminalId: req.body.terminal_id,
      forma: req.body.forma,
      valorCentavos: req.body.valor_centavos,
      parcelas: req.body.parcelas ?? 1,
      operadorId: req.usuario.id,
      caixaId: caixa?.id ?? null,
      nsu: req.body.nsu,
      autorizacao: req.body.autorizacao,
      bandeira: req.body.bandeira,
      cartaoFinal: req.body.cartao_final,
    });
    registrar(db, req, 'cartao_manual', { transacao: t.id, terminal: t.terminal_id, valor: t.valor_centavos, nsu: t.nsu });
    res.status(201).json(t);
  });

  r.get('/cobrancas/:id', (req, res) => res.json(maquininha.buscar(db, req.empresa.id, req.params.id)));

  r.post('/cobrancas/:id/cancelar', permitir(...OPERA), (req, res) => {
    const t = maquininha.cancelar(db, req.empresa.id, req.params.id);
    registrar(db, req, 'cartao_cancelado', { transacao: t.id, status: t.status });
    res.json(t);
  });

  // Últimas cobranças do operador (para retomar uma que ficou na tela).
  r.get('/cobrancas', (req, res) => {
    const itens = db.prepare(`SELECT x.*, t.nome AS terminal_nome FROM transacoes_cartao x JOIN terminais t ON t.id = x.terminal_id
      WHERE x.empresa_id = ? ORDER BY x.id DESC LIMIT 30`).all(req.empresa.id);
    res.json({ itens: itens.map((x) => ({ ...maquininha.publico(x), terminal_nome: x.terminal_nome })) });
  });

  return r;
};
