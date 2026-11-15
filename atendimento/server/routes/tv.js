'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { agora } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const { limitar, registrarRecusa } = require('../lib/limitador');
const { aoVivo } = require('../lib/aovivo');

/**
 * A TV da supervisão: lê só o painel ao vivo, autenticada pelo link da tela (tv_…), sem login.
 * O link não abre conversa, não envia nada e não serve em nenhuma outra rota.
 */
module.exports = function rotasTv(db) {
  const r = express.Router();
  // Uma TV atualiza a cada poucos segundos; várias TVs na mesma rede saem pelo mesmo IP.
  r.use(limitar({ janelaMs: 60_000, maximo: 240, todos: true }));

  const buscar = db.prepare(`SELECT t.id, t.empresa_id, t.ultimo_uso, e.status FROM telas_tv t JOIN empresas e ON e.id = t.empresa_id
    WHERE t.chave_hash = ? AND t.ativa = 1`);
  const usar = db.prepare('UPDATE telas_tv SET ultimo_uso = ?, ultimo_ip = ? WHERE id = ?');

  r.get('/ao-vivo', (req, res, next) => {
    const cab = req.get('authorization') ?? '';
    const chave = cab.startsWith('Bearer ') ? cab.slice(7).trim() : '';
    const tela = chave.startsWith('tv_') ? buscar.get(crypto.createHash('sha256').update(chave).digest('hex')) : null;
    if (!tela) {
      registrarRecusa(db, req.ip, 'tv: link inválido');
      return next(new ErroNegocio('Este link de TV não vale mais. Peça um novo a quem administra o painel.', 401));
    }
    if (tela.status !== 'ativa') return next(new ErroNegocio('Empresa bloqueada. Fale com o suporte.', 403));
    // "Visto por último" na lista de telas; grava no máximo a cada minuto.
    if (!tela.ultimo_uso || Date.now() - Date.parse(tela.ultimo_uso) > 60_000) usar.run(agora(), req.ip, tela.id);
    res.set('Cache-Control', 'no-store');
    return res.json(aoVivo(db, tela.empresa_id));
  });

  return r;
};
