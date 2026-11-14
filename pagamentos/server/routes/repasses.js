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

  /**
   * Creditado pelo banco (rateio): o dinheiro não passa pela PAY AX, mas o banco conta, no arquivo de
   * retorno, quanto creditou a cada cliente e quando. É isso que esta visão mostra — por boleto, e a
   * conferência de cada arquivo (soma dos registros contra o total que o banco declara).
   */
  r.get('/rateios', exigir('repasses.ver'), (req, res) => {
    const data = hoje();
    const cond = ['b.rateio_ppm IS NOT NULL', "b.situacao = 'liquidado'"];
    const p = [];
    if (req.query.cliente_id) { cond.push('b.cliente_id = ?'); p.push(Number(req.query.cliente_id)); }
    if (req.query.situacao) { cond.push('b.rateio_situacao = ?'); p.push(String(req.query.situacao)); }
    if (req.query.de) { cond.push('b.pago_em >= ?'); p.push(req.query.de); }
    if (req.query.ate) { cond.push('b.pago_em <= ?'); p.push(req.query.ate); }
    const lista = listaPaginada(db, `SELECT b.id, b.nosso_numero, b.nosso_numero_dv, b.pago_em, b.pago_valor_centavos, b.rateio_situacao, b.rateio_motivo,
        b.rateio_valor_centavos, b.rateio_credito_em, b.rateio_destino, c.id AS cliente_id, c.razao_social, c.nome_fantasia,
        (SELECT IFNULL(-SUM(valor_centavos), 0) FROM lancamentos WHERE boleto_id = b.id AND tipo = 'comissao') AS tarifa_payax_centavos
      FROM boletos b JOIN clientes c ON c.id = b.cliente_id WHERE ${cond.join(' AND ')}
      ORDER BY b.pago_em DESC, b.id DESC`, p, req.query);
    const soma = (where, ...args) => db.prepare(`SELECT COUNT(*) AS quantidade, IFNULL(SUM(rateio_valor_centavos), 0) AS valor_centavos
      FROM boletos WHERE rateio_ppm IS NOT NULL AND ${where}`).get(...args);
    res.json({
      ...lista,
      itens: lista.itens.map((x) => ({ ...x, destino: x.rateio_destino ? JSON.parse(x.rateio_destino) : null, rateio_destino: undefined })),
      resumo: {
        creditado_hoje: soma("rateio_situacao = 'efetuado' AND rateio_credito_em = ?", data),
        creditado_mes: soma("rateio_situacao = 'efetuado' AND rateio_credito_em BETWEEN ? AND ?", datas.primeiroDiaMes(data), data),
        aguardando_credito: soma("rateio_situacao = 'efetuado' AND rateio_credito_em > ?", data),
        a_confirmar: soma("rateio_situacao = 'a_confirmar'"),
        por_pix_mes: db.prepare(`SELECT COUNT(*) AS quantidade FROM boletos WHERE rateio_situacao = 'nao_efetuado' AND pago_em >= ?`).get(datas.primeiroDiaMes(data)),
      },
      arquivos: db.prepare(`SELECT id, nome, gerado_em, processado_em, rateio_total_centavos, rateio_quantidade, rateio_lido_centavos, rateio_lido_quantidade
        FROM retornos WHERE rateio_lido_quantidade > 0 OR rateio_quantidade > 0 ORDER BY id DESC LIMIT 10`).all()
        .map((a) => ({ ...a, confere: a.rateio_total_centavos === a.rateio_lido_centavos && a.rateio_quantidade === a.rateio_lido_quantidade })),
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

  /** Repassa agora tudo o que está liberado para um cliente, sem esperar a próxima rodada. */
  r.post('/', exigir('repasses.enviar'), async (req, res) => {
    const cliente = buscarCliente(req.body?.cliente_id);
    const repasse = await repassesLib.repassar(db, cliente, { usuario: req.usuario });
    if (!repasse) throw new ErroNegocio('Não há valor liberado para repassar a este cliente agora.', 409);
    auditoria.registrar(db, req, { acao: 'repasse.enviado', entidade: 'repasse', entidade_id: repasse.id, cliente_id: cliente.id,
      depois: { situacao: repasse.situacao, valor_liquido_centavos: repasse.valor_liquido_centavos } });
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
    auditoria.registrar(db, req, { acao: 'repasse.rotina', depois: { criados: out.criados, enviados: out.enviados, falhas: out.falhas } });
    res.json(out);
  });

  return r;
};
