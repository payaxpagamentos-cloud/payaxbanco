'use strict';

const { Router } = require('express');
const { transacao, agora, lerConfig } = require('../db');
const { dividir } = require('../lib/tarifa');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { hoje, somarDias } = require('../lib/datas');
const { dadosVeiculo } = require('./auth');
const cor = require('../lib/corridas');
const fin = require('../lib/financeiro');
const v = require('../lib/validacao');

module.exports = (db) => {
  const r = Router();
  r.use(permitir('motorista'));
  const id = (req) => req.usuario.id;
  const cid = (req) => Number(req.params.id);
  const lerPosicao = (b) => ({ lat: v.numero(b.lat, 'a latitude', { min: -90, max: 90 }), lng: v.numero(b.lng, 'a longitude', { min: -180, max: 180 }) });

  r.get('/perfil', (req, res) => {
    const m = db.prepare('SELECT * FROM motoristas WHERE usuario_id = ?').get(id(req));
    res.json({
      ...m, nome: req.usuario.nome, email: req.usuario.email, telefone: req.usuario.telefone,
      veiculos: db.prepare('SELECT * FROM veiculos WHERE motorista_id = ? ORDER BY id').all(id(req)),
      saldo_centavos: fin.saldo(db, id(req)),
      ...cor.notaMedia(db, id(req)),
    });
  });

  r.patch('/perfil', (req, res) => {
    if (req.body.chave_pix !== undefined) {
      db.prepare('UPDATE motoristas SET chave_pix = ? WHERE usuario_id = ?').run(v.opcional(req.body.chave_pix, 'a chave PIX', 120), id(req));
    }
    res.status(204).end();
  });

  /** Novo veículo: entra pendente de aprovação. */
  r.post('/veiculos', (req, res) => {
    const d = dadosVeiculo(req.body);
    if (db.prepare('SELECT 1 FROM veiculos WHERE placa = ?').get(d.placa)) throw new ErroNegocio('Placa já cadastrada.', 409);
    const x = db.prepare('INSERT INTO veiculos (motorista_id, placa, marca_modelo, cor, ano, categoria, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id(req), d.placa, d.marca_modelo, d.cor, d.ano, d.categoria, agora());
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });

  /** Fica online (com veículo e posição) ou offline. Não sai do ar com corrida em andamento. */
  r.post('/online', (req, res) => {
    const online = req.body.online === true;
    transacao(db, () => {
      if (!online) {
        const ativa = cor.corridaAtivaMotorista(db, id(req));
        if (ativa) throw new ErroNegocio('Finalize a corrida antes de ficar offline.', 409);
        db.prepare('UPDATE motoristas SET online = 0 WHERE usuario_id = ?').run(id(req));
        return;
      }
      if (req.body.veiculo_id !== undefined) {
        const vei = db.prepare('SELECT * FROM veiculos WHERE id = ? AND motorista_id = ?').get(Number(req.body.veiculo_id), id(req));
        if (!vei) throw naoEncontrado('Veículo');
        db.prepare('UPDATE motoristas SET veiculo_id = ? WHERE usuario_id = ?').run(vei.id, id(req));
      }
      cor.motoristaApto(db, id(req));
      const p = lerPosicao(req.body);
      db.prepare('UPDATE motoristas SET online = 1 WHERE usuario_id = ?').run(id(req));
      cor.posicao(db, id(req), p.lat, p.lng);
    });
    res.status(204).end();
  });

  r.post('/posicao', (req, res) => {
    const p = lerPosicao(req.body);
    cor.posicao(db, id(req), p.lat, p.lng);
    res.status(204).end();
  });

  r.get('/ofertas', (req, res) => res.json(cor.ofertas(db, id(req))));
  r.post('/ofertas/:id/aceitar', (req, res) => { cor.aceitar(db, id(req), cid(req)); res.status(204).end(); });
  r.post('/ofertas/:id/recusar', (req, res) => { cor.recusar(db, id(req), cid(req)); res.status(204).end(); });

  /** Corrida em curso; sem ela, a última finalizada nos 15 minutos anteriores que o motorista ainda não avaliou. */
  r.get('/corrida-atual', (req, res) => {
    const c = cor.detalhar(db, cor.corridaAtivaMotorista(db, id(req))
      ?? db.prepare(`SELECT * FROM corridas WHERE motorista_id = ? AND status = 'finalizada' AND nota_do_motorista IS NULL
        AND finalizada_em > ? ORDER BY id DESC LIMIT 1`).get(id(req), new Date(Date.now() - 15 * 60_000).toISOString()));
    if (!c) return res.json(null);
    // O motorista vê o que recebe (sem a taxa) e não os pagamentos do passageiro.
    delete c.cobrancas;
    delete c.valor_pago_centavos;
    res.json({ ...c, ganho_estimado_centavos: dividir(c.valor_estimado_centavos, lerConfig(db).taxa_plataforma_bp).valor_motorista_centavos });
  });
  r.post('/corridas/:id/chegou', (req, res) => { cor.chegou(db, id(req), cid(req)); res.status(204).end(); });
  r.post('/corridas/:id/iniciar', (req, res) => { cor.iniciar(db, id(req), cid(req)); res.status(204).end(); });
  r.post('/corridas/:id/finalizar', (req, res) => res.json(cor.finalizar(db, id(req), cid(req))));
  r.post('/corridas/:id/cancelar', (req, res) => { cor.cancelar(db, 'motorista', cid(req), req.body.motivo, req.usuario); res.status(204).end(); });
  r.post('/corridas/:id/avaliar', (req, res) => { cor.avaliar(db, 'motorista', cid(req), req.usuario, req.body); res.status(204).end(); });

  r.get('/corridas', (req, res) => res.json(db.prepare(`SELECT id, status, categoria, origem_endereco, destino_endereco, aceita_em, finalizada_em, forma_pagamento,
      pagamento_status, valor_final_centavos, valor_motorista_centavos, taxa_plataforma_centavos, nota_do_passageiro
    FROM corridas WHERE motorista_id = ? ORDER BY id DESC LIMIT 100`).all(id(req))));

  /** Ganhos do período (padrão: hoje), saldo, extrato e repasses. */
  r.get('/ganhos', (req, res) => {
    const ate = req.query.ate ? v.data(req.query.ate, 'a data final') : hoje();
    const de = req.query.de ? v.data(req.query.de, 'a data inicial') : ate;
    v.exigir(de <= ate && de >= somarDias(ate, -366), 'Período inválido (até um ano).');
    res.json({
      ...fin.ganhos(db, id(req), de, ate),
      saldo_centavos: fin.saldo(db, id(req)),
      extrato: fin.extrato(db, id(req), 50),
      repasses: db.prepare('SELECT id, valor_centavos, chave_pix, status, criado_em, concluido_em, identificador FROM repasses WHERE motorista_id = ? ORDER BY id DESC LIMIT 30').all(id(req)),
    });
  });

  return r;
};
