'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hoje } = require('../lib/datas');
const propostas = require('../lib/propostas');
const v = require('../lib/validacao');

/**
 * Propostas comerciais: o funil entre o inventário e o contrato.
 * A proposta guarda a folha do dia em que foi feita (ver lib/propostas.js) e, aceita, vira contrato
 * e campanha sem ninguém redigitar o que já foi combinado.
 */
module.exports = (db) => {
  const r = Router();

  r.get('/propostas', (req, res) => res.json(propostas.listar(db, req.query)));

  r.get('/propostas/:id', (req, res) => res.json(propostas.detalhe(db, Number(req.params.id))));

  r.post('/propostas', (req, res) => {
    const p = propostas.criar(db, {
      circuito_id: Number(req.body.circuito_id),
      anunciante_id: req.body.anunciante_id || null,
      meses: req.body.meses,
      desconto_percentual: req.body.desconto_percentual,
      validade_dias: req.body.validade_dias,
      insercoes_hora: req.body.insercoes_hora,
      observacao: v.opcional(req.body.observacao, 'a observação', 500),
    }, req.usuario.id);
    registrar(db, req, 'proposta_criada', { id: p.id, numero: p.numero, total_centavos: p.total_centavos });
    res.status(201).json(p);
  });

  /** Marca como enviada ao cliente — é o que separa o rascunho do que está na mesa. */
  r.post('/propostas/:id/enviar', (req, res) => {
    const id = Number(req.params.id);
    const p = propostas.detalhe(db, id);
    if (p.status !== 'rascunho') throw new ErroNegocio('Só um rascunho pode ser enviado.', 409);
    db.prepare("UPDATE propostas SET status = 'enviada', enviada_em = ? WHERE id = ?").run(hoje(), id);
    registrar(db, req, 'proposta_enviada', { id, numero: p.numero });
    res.json(propostas.detalhe(db, id));
  });

  /** Aceita: nasce o contrato e a campanha (rascunho) com o que foi vendido. */
  r.post('/propostas/:id/aceitar', (req, res) => {
    const feito = propostas.aceitar(db, Number(req.params.id), {
      anuncianteId: req.body.anunciante_id ? Number(req.body.anunciante_id) : null,
      inicio: req.body.inicio ? v.data(req.body.inicio, 'o início da vigência') : null,
      usuarioId: req.usuario.id,
    });
    registrar(db, req, 'proposta_aceita', { id: feito.id, numero: feito.numero, ...feito.criado });
    res.json(feito);
  });

  r.post('/propostas/:id/recusar', (req, res) => {
    const id = Number(req.params.id);
    const p = propostas.detalhe(db, id);
    if (p.status === 'aceita') throw new ErroNegocio('Proposta aceita não pode ser recusada.', 409);
    const motivo = v.texto(req.body.motivo, 'o motivo', 300);
    db.prepare("UPDATE propostas SET status = 'recusada', motivo = ?, respondida_em = ? WHERE id = ?").run(motivo, hoje(), id);
    registrar(db, req, 'proposta_recusada', { id, numero: p.numero, motivo });
    res.json(propostas.detalhe(db, id));
  });

  /** Reabre uma proposta recusada como rascunho, para refazer o preço sem perder o histórico do número. */
  r.post('/propostas/:id/reabrir', (req, res) => {
    const id = Number(req.params.id);
    const p = propostas.detalhe(db, id);
    if (p.status === 'aceita') throw new ErroNegocio('Proposta aceita não volta para rascunho.', 409);
    db.prepare("UPDATE propostas SET status = 'rascunho', motivo = NULL, respondida_em = NULL, enviada_em = NULL WHERE id = ?").run(id);
    registrar(db, req, 'proposta_reaberta', { id, numero: p.numero });
    res.json(propostas.detalhe(db, id));
  });

  r.delete('/propostas/:id', (req, res) => {
    const id = Number(req.params.id);
    const p = propostas.detalhe(db, id);
    if (p.status === 'aceita') throw new ErroNegocio('Proposta aceita não é excluída: ela virou contrato.', 409);
    db.prepare('DELETE FROM propostas WHERE id = ?').run(id);
    registrar(db, req, 'proposta_excluida', { id, numero: p.numero });
    res.status(204).end();
  });

  return r;
};
