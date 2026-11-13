'use strict';

const express = require('express');
const config = require('../config');
const { naoEncontrado, ErroNegocio } = require('../lib/erros');
const { exigir } = require('../auth');
const { listaPaginada, csv } = require('../lib/http');
const v = require('../lib/validacao');
const datas = require('../lib/datas');
const repassesLib = require('../lib/repasses');
const auditoria = require('../lib/auditoria');

const hoje = () => datas.dataLocal(config.fusoPadrao);

module.exports = (db) => {
  const r = express.Router();
  const buscarCliente = (id) => {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(id));
    if (!c) throw naoEncontrado('Cliente');
    return c;
  };

  r.get('/', exigir('repasses.ver'), (req, res) => {
    const cond = [];
    const p = [];
    if (req.query.situacao) { cond.push('r.situacao = ?'); p.push(req.query.situacao); }
    if (req.query.cliente_id) { cond.push('r.cliente_id = ?'); p.push(Number(req.query.cliente_id)); }
    if (req.query.de) { cond.push('date(r.criado_em) >= ?'); p.push(req.query.de); }
    if (req.query.ate) { cond.push('date(r.criado_em) <= ?'); p.push(req.query.ate); }
    const sql = `SELECT r.*, c.razao_social, c.nome_fantasia, u.nome AS aprovado_por_nome
      FROM repasses r JOIN clientes c ON c.id = r.cliente_id LEFT JOIN usuarios u ON u.id = r.aprovado_por
      ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY r.id DESC`;
    const lista = listaPaginada(db, sql, p, req.query);
    res.json({
      ...lista,
      resumo: db.prepare(`SELECT situacao, COUNT(*) AS quantidade, IFNULL(SUM(valor_liquido_centavos), 0) AS valor_centavos
        FROM repasses GROUP BY situacao`).all(),
    });
  });

  r.get('/export.csv', exigir('repasses.ver'), (req, res) => {
    const itens = db.prepare(`SELECT r.*, c.razao_social FROM repasses r JOIN clientes c ON c.id = r.cliente_id
      WHERE (? IS NULL OR date(r.criado_em) >= ?) AND (? IS NULL OR date(r.criado_em) <= ?) ORDER BY r.id DESC`)
      .all(req.query.de ?? null, req.query.de ?? null, req.query.ate ?? null, req.query.ate ?? null);
    const linhas = [['#', 'Cliente', 'Criado em', 'Valor (R$)', 'Tarifa (R$)', 'Líquido (R$)', 'Chave PIX', 'Situação', 'End-to-end']];
    for (const x of itens) {
      linhas.push([x.id, x.razao_social, x.criado_em, (x.valor_centavos / 100).toFixed(2).replace('.', ','),
        (x.taxa_centavos / 100).toFixed(2).replace('.', ','), (x.valor_liquido_centavos / 100).toFixed(2).replace('.', ','),
        x.pix_chave, x.situacao, x.end_to_end ?? '']);
    }
    res.type('text/csv; charset=utf-8').attachment(`repasses-${hoje()}.csv`).send(csv(linhas));
  });

  /** Repasse criado pela nossa equipe (fora da rotina automática). */
  r.post('/', exigir('repasses.aprovar'), async (req, res) => {
    const cliente = buscarCliente(req.body?.cliente_id);
    const d = repassesLib.disponivel(db, cliente, hoje());
    const valor = req.body?.valor === undefined || req.body?.valor === '' || req.body?.valor === 'tudo'
      ? d.disponivel_centavos
      : v.centavos(req.body.valor, 'o valor');
    const repasse = repassesLib.solicitar(db, cliente, { valor_centavos: valor }, { usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'repasse.solicitado', entidade: 'repasse', entidade_id: repasse.id, cliente_id: cliente.id, depois: repasse });
    if (repasse.situacao === 'aprovado' && v.booleano(req.body?.enviar_agora)) {
      const enviado = await repassesLib.enviar(db, repasse.id, { usuario: req.usuario });
      return res.status(201).json(enviado);
    }
    res.status(201).json(repasse);
  });

  r.post('/:id/aprovar', exigir('repasses.aprovar'), (req, res) => {
    const out = repassesLib.aprovar(db, Number(req.params.id), req.usuario);
    auditoria.registrar(db, req, { acao: 'repasse.aprovado', entidade: 'repasse', entidade_id: out.id, cliente_id: out.cliente_id });
    res.json(out);
  });

  r.post('/:id/enviar', exigir('repasses.enviar'), async (req, res) => {
    const out = await repassesLib.enviar(db, Number(req.params.id), { usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'repasse.enviado', entidade: 'repasse', entidade_id: out.id, cliente_id: out.cliente_id, depois: { situacao: out.situacao, end_to_end: out.end_to_end } });
    res.json(out);
  });

  r.post('/:id/cancelar', exigir('repasses.aprovar'), (req, res) => {
    const motivo = v.texto(req.body?.motivo, 'o motivo', 160);
    const out = repassesLib.cancelar(db, Number(req.params.id), motivo, req.usuario);
    auditoria.registrar(db, req, { acao: 'repasse.cancelado', entidade: 'repasse', entidade_id: out.id, cliente_id: out.cliente_id, depois: { motivo } });
    res.json(out);
  });

  /** Roda agora a rotina que normalmente acontece sozinha (útil para fechar o dia na mão). */
  r.post('/rotina', exigir('repasses.enviar'), async (req, res) => {
    const out = await repassesLib.rotinaAutomatica(db, { usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'repasse.rotina', depois: { criados: out.criados, enviados: out.enviados, aguardando: out.aguardando, falhas: out.falhas } });
    res.json(out);
  });

  return r;
};
