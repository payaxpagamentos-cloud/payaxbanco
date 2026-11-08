'use strict';

const { Router } = require('express');
const { transacao } = require('../db');
const { permitir } = require('../auth');
const { registrar } = require('../lib/auditoria');
const aprov = require('../lib/aprovacao');
const avisos = require('../lib/avisos');

// Avisa o cliente sem travar a resposta; falhas ficam registradas na tabela de e-mails.
const avisar = (db, empresaId, ids) => { for (const id of ids) avisos.avisarAprovacao(db, empresaId, id).catch(() => {}); };
const v = require('../lib/validacao');

module.exports = (db) => {
  const r = Router();
  const eid = (req) => req.empresa.id;

  r.get('/', (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuario.id);
    res.json({
      config: { aprovacao_ativa: Boolean(req.empresa.aprovacao_ativa), aprovacao_acima_centavos: req.empresa.aprovacao_acima_centavos },
      minha_alcada_centavos: aprov.alcadaUsuario(u),
      itens: aprov.fila(db, eid(req), req.query.status || 'abertas'),
    });
  });

  r.get('/:id/historico', (req, res) => res.json(aprov.historico(db, Number(req.params.id))));

  r.post('/:id/conferir', (req, res) => {
    aprov.conferir(db, req, eid(req), req.params.id, req.body.comentario);
    registrar(db, req, 'pagamento_conferido', { id: Number(req.params.id) }, eid(req));
    avisar(db, eid(req), [Number(req.params.id)]);
    res.status(204).end();
  });
  for (const [rota, aprovar] of [['aprovar', true], ['recusar', false]]) {
    r.post(`/:id/${rota}`, (req, res) => {
      aprov.decidir(db, { usuario: req.usuario }, eid(req), req.params.id, aprovar, req.body.comentario);
      registrar(db, req, aprovar ? 'pagamento_aprovado' : 'pagamento_recusado', { id: Number(req.params.id), comentario: req.body.comentario }, eid(req));
      res.status(204).end();
    });
  }

  // Em lote: tudo ou nada.
  r.post('/lote', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    v.exigir(ids.length && ids.length <= 200, 'Selecione de 1 a 200 pagamentos.');
    v.exigir(['conferir', 'aprovar'].includes(req.body.acao), 'Ação inválida.');
    transacao(db, () => {
      for (const id of ids) {
        if (req.body.acao === 'conferir') aprov.conferir(db, req, eid(req), id, req.body.comentario);
        else aprov.decidir(db, { usuario: req.usuario }, eid(req), id, true, req.body.comentario);
      }
    });
    registrar(db, req, req.body.acao === 'conferir' ? 'pagamentos_conferidos' : 'pagamentos_aprovados', { ids }, eid(req));
    if (req.body.acao === 'conferir') avisar(db, eid(req), ids);
    res.json({ processados: ids.length });
  });

  // Regra da empresa: liga a aprovação e define a partir de que valor ela é exigida.
  r.patch('/config', permitir('admin', 'supervisor'), (req, res) => {
    const ativa = Boolean(req.body.aprovacao_ativa);
    const acima = v.valorCentavos(req.body.aprovacao_acima_centavos ?? 0, 'valor mínimo', { zero: true });
    db.prepare('UPDATE empresas SET aprovacao_ativa = ?, aprovacao_acima_centavos = ? WHERE id = ?').run(ativa ? 1 : 0, acima, eid(req));
    registrar(db, req, 'aprovacao_configurada', { aprovacao_ativa: ativa, aprovacao_acima_centavos: acima }, eid(req));
    res.status(204).end();
  });

  return r;
};
