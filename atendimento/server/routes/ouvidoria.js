'use strict';

const express = require('express');
const { auditar, transacao } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const ouvidoriaLib = require('../lib/ouvidoria');
const cliente360 = require('../lib/cliente360');
const { hoje, inicioMes, intervalo } = require('../lib/datas');
const v = require('../lib/validacao');

/** Ouvidoria e a ficha 360° do cliente. */
module.exports = function rotasOuvidoria(db) {
  const r = express.Router();

  r.get('/', (req, res, next) => {
    try {
      res.json({
        ...ouvidoriaLib.listar(db, req.empresa.id, {
          status: req.query.status ?? 'abertas',
          tipo: req.query.tipo ?? '',
          responsavelId: req.query.responsavel_id ?? '',
          busca: String(req.query.busca ?? '').trim(),
          ...(req.query.de ? { de: intervalo(v.data(req.query.de, 'a data inicial'), v.data(req.query.ate ?? req.query.de, 'a data final'))[0] } : {}),
          ...(req.query.ate ? { ate: intervalo(v.data(req.query.de ?? req.query.ate, 'a data inicial'), v.data(req.query.ate, 'a data final'))[1] } : {}),
          pagina: Number(req.query.pagina) || 1,
        }),
        tipos: ouvidoriaLib.TIPOS,
        indicadores: ouvidoriaLib.indicadores(db, req.empresa.id, { de: inicioMes(), ate: hoje() }),
      });
    } catch (err) { next(err); }
  });

  r.get('/:id', async (req, res, next) => {
    try { res.json(await ouvidoriaLib.detalhe(db, req.empresa.id, Number(req.params.id))); } catch (err) { next(err); }
  });

  /** Abertura manual pela equipe (a atendente virtual abre sozinha pela ferramenta). */
  r.post('/', async (req, res, next) => {
    try {
      const d = req.body ?? {};
      const contato = db.prepare('SELECT * FROM contatos WHERE id = ? AND empresa_id = ?').get(Number(d.contato_id), req.empresa.id);
      if (!contato) throw new ErroNegocio('Informe um contato desta empresa.', 404);
      const conversa = d.conversa_id ? db.prepare('SELECT * FROM conversas WHERE id = ? AND empresa_id = ?').get(Number(d.conversa_id), req.empresa.id) : null;
      let ficha = null;
      try { ficha = await cliente360.ficha(db, req.empresa.id, contato.id, { ixcClienteId: conversa?.ixc_cliente_id }); } catch { ficha = null; }
      const { ouvidoria, ja_existia: jaExistia } = ouvidoriaLib.abrir(db, {
        empresa: req.empresa, contato, conversa, origem: 'atendente', usuario: req.usuario, ficha,
        tipo: d.tipo, assunto: d.assunto, relato: v.opcional(d.relato, 'o relato', 4000),
        prioridade: d.prioridade ? v.opcao(d.prioridade, 'a prioridade', ['baixa', 'normal', 'alta']) : null,
      });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'abriu caso na ouvidoria', alvo: ouvidoria.protocolo, detalhe: ouvidoria.tipo, ip: req.ip });
      res.status(201).json({ ...ouvidoriaLib.enriquecer(ouvidoria), ja_existia: jaExistia });
    } catch (err) { next(err); }
  });

  r.post('/:id/assumir', (req, res, next) => {
    try { res.json(ouvidoriaLib.enriquecer(ouvidoriaLib.assumir(db, req.empresa.id, Number(req.params.id), req.usuario))); } catch (err) { next(err); }
  });

  r.post('/:id/tratativas', (req, res, next) => {
    try {
      const o = ouvidoriaLib.buscar(db, req.empresa.id, Number(req.params.id));
      ouvidoriaLib.evento(db, o.id, {
        tipo: v.opcao(req.body?.tipo ?? 'tratativa', 'o tipo', ['tratativa', 'contato', 'proposta', 'prazo']),
        texto: v.texto(req.body?.texto, 'a tratativa', 4000),
        usuarioId: req.usuario.id,
      });
      res.status(201).json({ ok: true });
    } catch (err) { next(err); }
  });

  r.patch('/:id', (req, res, next) => {
    try {
      const o = ouvidoriaLib.buscar(db, req.empresa.id, Number(req.params.id));
      const d = req.body ?? {};
      if (d.prioridade) db.prepare('UPDATE ouvidoria SET prioridade = ? WHERE id = ?').run(v.opcao(d.prioridade, 'a prioridade', ['baixa', 'normal', 'alta']), o.id);
      if (d.assunto) db.prepare('UPDATE ouvidoria SET assunto = ? WHERE id = ?').run(v.texto(d.assunto, 'o assunto', 200), o.id);
      if (d.responsavel_id !== undefined) {
        const alvo = d.responsavel_id ? db.prepare('SELECT id FROM usuarios WHERE id = ? AND empresa_id = ? AND ativo = 1').get(Number(d.responsavel_id), req.empresa.id) : null;
        db.prepare('UPDATE ouvidoria SET responsavel_id = ? WHERE id = ?').run(alvo?.id ?? null, o.id);
      }
      res.json(ouvidoriaLib.enriquecer(ouvidoriaLib.buscar(db, req.empresa.id, o.id)));
    } catch (err) { next(err); }
  });

  r.post('/:id/encerrar', (req, res, next) => {
    try {
      const d = req.body ?? {};
      const fechada = transacao(db, () => ouvidoriaLib.encerrar(db, req.empresa.id, Number(req.params.id), req.usuario, {
        status: d.status ?? 'resolvida', desfecho: d.desfecho, retido: d.retido,
      }));
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'encerrou caso na ouvidoria', alvo: fechada.protocolo, detalhe: fechada.status, ip: req.ip });
      res.json(ouvidoriaLib.enriquecer(fechada));
    } catch (err) { next(err); }
  });

  return r;
};
