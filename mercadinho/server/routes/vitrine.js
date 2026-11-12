'use strict';

const express = require('express');
const config = require('../config');
const vitrine = require('../lib/vitrine');
const { naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');

/** Vitrine: a sequência pública (TV e tablet) e a gestão dos vídeos e imagens. */
module.exports = (db, { autenticado, gestao }) => {
  const r = express.Router();

  /** Público de propósito: a TV não faz login. Só sai nome, foto e preço (ver lib/vitrine.js). */
  r.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(vitrine.playlist(db));
  });

  const g = express.Router();
  g.get('/resumo', (_req, res) => res.json(vitrine.resumo(db)));
  g.get('/midias', (_req, res) => res.json(vitrine.listarMidias(db)));

  // O arquivo vem cru no corpo; título e duração vão na URL. O limite aqui é o do vídeo (o maior);
  // a imagem tem limite próprio, conferido depois de saber o formato.
  const tiposAceitos = ['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'];
  g.post('/midias', express.raw({ type: tiposAceitos, limit: config.vitrineVideoMaxBytes + 1024 }), (req, res) => {
    const titulo = v.opcional(req.query.titulo, 'o título', 80) ?? '';
    const duracao_seg = req.query.duracao ? v.inteiro(req.query.duracao, 'a duração', { min: 3, max: 120 }) : 10;
    const m = vitrine.guardarMidia(db, req.body, { titulo, duracao_seg });
    registrar(db, req, 'vitrine_midia_enviada', `${m.tipo} #${m.id}`);
    res.status(201).json(m);
  });

  g.patch('/midias/:id', express.json(), (req, res) => {
    const id = v.inteiro(req.params.id, 'a mídia', { min: 1 });
    if (!vitrine.obterMidia(db, id)) throw naoEncontrado('Mídia');
    const d = req.body ?? {};
    const campos = {};
    if (d.titulo !== undefined) campos.titulo = v.opcional(d.titulo, 'o título', 80) ?? '';
    if (d.duracao_seg !== undefined) campos.duracao_seg = v.inteiro(d.duracao_seg, 'a duração', { min: 3, max: 120 });
    if (d.ativa !== undefined) campos.ativa = d.ativa ? 1 : 0;
    const colunas = Object.keys(campos);
    if (colunas.length) db.prepare(`UPDATE vitrine_midias SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((c) => campos[c]), id);
    res.json(vitrine.obterMidia(db, id));
  });

  g.post('/midias/ordem', express.json(), (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => v.inteiro(id, 'a mídia', { min: 1 })) : [];
    res.json(vitrine.ordenarMidias(db, ids));
  });

  g.delete('/midias/:id', (req, res) => {
    const m = vitrine.apagarMidia(db, v.inteiro(req.params.id, 'a mídia', { min: 1 }));
    registrar(db, req, 'vitrine_midia_apagada', `${m.tipo} #${m.id}`);
    res.status(204).end();
  });

  r.use('/gestao', autenticado, gestao, g);
  return r;
};
