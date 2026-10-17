'use strict';

const { Router } = require('express');
const { lerConfig, transacao } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const pag = require('../lib/pagamentos');
const emp = require('../lib/empresas');
const { distancia } = require('../lib/geo');
const cor = require('../lib/corridas');
const v = require('../lib/validacao');

module.exports = (db) => {
  const r = Router();
  r.use(permitir('passageiro'));
  const minha = (req) => {
    const c = cor.buscar(db, Number(req.params.id));
    if (c.passageiro_id !== req.usuario.id) throw naoEncontrado('Corrida');
    return c;
  };

  r.get('/estimativa', (req, res) => {
    const o = { lat: v.numero(req.query.olat, 'a latitude da origem', { min: -90, max: 90 }), lng: v.numero(req.query.olng, 'a longitude da origem', { min: -180, max: 180 }) };
    const d = { lat: v.numero(req.query.dlat, 'a latitude do destino', { min: -90, max: 90 }), lng: v.numero(req.query.dlng, 'a longitude do destino', { min: -180, max: 180 }) };
    res.json(cor.estimar(db, o, d));
  });

  /** Motoristas online por perto (só a posição, para mostrar no mapa). */
  r.get('/proximos', (req, res) => {
    const lat = v.numero(req.query.lat, 'a latitude', { min: -90, max: 90 });
    const lng = v.numero(req.query.lng, 'a longitude', { min: -180, max: 180 });
    const corte = new Date(Date.now() - 5 * 60_000).toISOString();
    const { raio_busca_km: raio } = lerConfig(db);
    const lista = db.prepare(`SELECT m.lat, m.lng, v.categoria FROM motoristas m JOIN veiculos v ON v.id = m.veiculo_id
      WHERE m.online = 1 AND m.situacao = 'aprovado' AND m.lat IS NOT NULL AND m.posicao_em > ?`).all(corte)
      .filter((m) => distancia(m, { lat, lng }) <= raio * 1000)
      // Arredonda a posição (cerca de 100 m): o passageiro vê que há carros, não onde exatamente cada um está.
      .map((m) => ({ lat: Math.round(m.lat * 1000) / 1000, lng: Math.round(m.lng * 1000) / 1000, categoria: m.categoria }));
    res.json(lista);
  });

  /** Empresas pelas quais a gestão autorizou este passageiro a pedir (forma "empresa"). */
  r.get('/empresas', (req, res) => res.json(emp.autorizadas(db, req.usuario.id)));

  r.post('/corridas', (req, res) => res.status(201).json(cor.solicitar(db, req.usuario.id, req.body)));

  r.get('/corridas/atual', (req, res) => {
    cor.expirarSolicitacoes(db);
    res.json(cor.detalhar(db, cor.corridaAtivaPassageiro(db, req.usuario.id)));
  });

  r.get('/corridas', (req, res) => res.json(db.prepare(`SELECT c.id, c.status, c.categoria, c.origem_endereco, c.destino_endereco, c.solicitada_em, c.finalizada_em,
      c.valor_estimado_centavos, c.valor_final_centavos, c.forma_pagamento, c.pagamento_status, c.nota_do_passageiro, u.nome AS motorista_nome
    FROM corridas c LEFT JOIN usuarios u ON u.id = c.motorista_id WHERE c.passageiro_id = ? ORDER BY c.id DESC LIMIT 100`).all(req.usuario.id)));

  r.get('/corridas/:id', (req, res) => res.json(cor.detalhar(db, minha(req))));

  r.post('/corridas/:id/cancelar', (req, res) => {
    cor.cancelar(db, 'passageiro', Number(req.params.id), req.body.motivo, req.usuario);
    res.status(204).end();
  });

  r.post('/corridas/:id/avaliar', (req, res) => {
    cor.avaliar(db, 'passageiro', Number(req.params.id), req.usuario, req.body);
    res.status(204).end();
  });

  /** Cobrança em aberto da corrida (pagamento antes da viagem ou complemento do taxímetro), com o PIX para pagar. */
  r.get('/corridas/:id/cobranca', async (req, res) => {
    const c = minha(req);
    const cob = db.prepare(`SELECT * FROM cobrancas WHERE corrida_id = ? AND status = 'pendente' AND tipo <> 'estorno' ORDER BY id DESC LIMIT 1`).get(c.id);
    if (!cob) throw new ErroNegocio('Nenhum pagamento pendente nesta corrida.', 409);
    res.json(await pag.paraPagar(db, cob));
  });

  /** Modo de testes: aprova o pagamento como se o banco tivesse confirmado. */
  r.post('/cobrancas/:id/simular', (req, res) => {
    if (pag.modo() !== 'simulado') throw new ErroNegocio('Disponível só no modo de testes.', 403);
    const cob = pag.buscar(db, Number(req.params.id));
    if (cor.buscar(db, cob.corrida_id).passageiro_id !== req.usuario.id || cob.tipo === 'estorno') throw naoEncontrado('Cobrança');
    transacao(db, () => pag.concluir(db, cob.id, req.usuario.id, `SIMULADO-${cob.id}`));
    res.status(204).end();
  });

  return r;
};
