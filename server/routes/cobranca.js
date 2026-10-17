'use strict';

const { Router } = require('express');
const { registrar } = require('../lib/auditoria');
const cob = require('../lib/cobranca');
const avisos = require('../lib/avisos');
const email = require('../lib/email');
const v = require('../lib/validacao');

module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;

  r.get('/', (req, res) => res.json(cob.painel(db, eid(req))));
  r.get('/lembretes', (req, res) => res.json(cob.lembretes(db, req.empresa, Math.min(30, Math.max(0, Number(req.query.dias ?? 3))))));
  r.get('/config', (req, res) => res.json({ email_configurado: email.configurado(), chave_pix_cobranca: req.empresa.chave_pix_cobranca,
    lembrete_auto: Boolean(req.empresa.lembrete_auto), lembrete_dias_antes: req.empresa.lembrete_dias_antes }));
  r.post('/lembretes/:id/email', async (req, res) => {
    await avisos.enviarLembrete(db, req, req.empresa, req.params.id);
    registrar(db, req, 'lembrete_email', { lancamento_id: Number(req.params.id) }, eid(req));
    res.json({ enviado: true });
  });
  r.get('/clientes/:id', (req, res) => res.json(cob.ficha(db, eid(req), req.params.id)));

  r.post('/registros', (req, res) => {
    const id = cob.registrarContato(db, req, eid(req), req.body);
    registrar(db, req, 'cobranca_registrada', { id, canal: req.body.canal, contato_id: req.body.contato_id }, eid(req));
    res.status(201).json({ id });
  });
  r.post('/promessas', (req, res) => {
    const id = cob.registrarPromessa(db, req, eid(req), req.body);
    registrar(db, req, 'promessa_registrada', { id, contato_id: req.body.contato_id, valor_centavos: req.body.valor_centavos }, eid(req));
    res.status(201).json({ id });
  });
  r.post('/promessas/:id/resolver', (req, res) => {
    cob.resolverPromessa(db, eid(req), req.params.id, req.body.status);
    registrar(db, req, 'promessa_resolvida', { id: Number(req.params.id), status: req.body.status }, eid(req));
    res.status(204).end();
  });
  r.post('/acordos', (req, res) => {
    const a = cob.acordo(db, req, eid(req), req.body);
    registrar(db, req, 'acordo_criado', a, eid(req));
    res.status(201).json(a);
  });
  r.patch('/config', (req, res) => {
    const e = req.empresa;
    const auto = 'lembrete_auto' in req.body ? (req.body.lembrete_auto ? 1 : 0) : e.lembrete_auto;
    const dias = 'lembrete_dias_antes' in req.body ? Number(req.body.lembrete_dias_antes) : e.lembrete_dias_antes;
    v.exigir(Number.isInteger(dias) && dias >= 0 && dias <= 15, 'Dias de antecedência: de 0 a 15.');
    const pix = 'chave_pix_cobranca' in req.body ? v.texto(req.body.chave_pix_cobranca, 120) : e.chave_pix_cobranca;
    db.prepare('UPDATE empresas SET chave_pix_cobranca = ?, lembrete_auto = ?, lembrete_dias_antes = ? WHERE id = ?').run(pix, auto, dias, eid(req));
    registrar(db, req, 'cobranca_configurada', { lembrete_auto: Boolean(auto), lembrete_dias_antes: dias }, eid(req));
    res.status(204).end();
  });
  return r;
};
