'use strict';

const { Router } = require('express');
const { configPublica } = require('../lib/ixcEmpresa');
const { caixaDoOperador, resumo: resumoCaixa } = require('../lib/caixa');
const { pendencias } = require('../lib/baixas');
const { hoje } = require('../lib/datas');

/** Painel de uma empresa: /api/empresas/:eid/... */
module.exports = (db) => {
  const r = Router({ mergeParams: true });

  // Primeira chamada do painel: quem é a empresa, o que está configurado e como está o caixa de quem entrou.
  r.get('/', (req, res) => {
    const e = req.empresa;
    const caixa = caixaDoOperador(db, e.id, req.usuario.id);
    const totaisHoje = db.prepare(`SELECT COUNT(*) AS quantidade, COALESCE(SUM(valor_centavos), 0) AS total_centavos
      FROM recebimentos WHERE empresa_id = ? AND data = ? AND status = 'confirmado'`).get(e.id, hoje());
    res.json({
      empresa: { id: e.id, nome: e.nome, documento: e.documento, status: e.status },
      config: configPublica(db, e.id),
      lojas: db.prepare('SELECT id, nome, ativa FROM lojas WHERE empresa_id = ? ORDER BY nome').all(e.id),
      pdvs: db.prepare('SELECT id, loja_id, nome, ativo FROM pdvs WHERE empresa_id = ? ORDER BY nome').all(e.id),
      terminais: db.prepare('SELECT id, loja_id, pdv_id, nome, adquirente, modo, ativo FROM terminais WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(e.id),
      caixa: caixa ? { ...caixa, contagem: undefined, resumo: resumoCaixa(db, caixa) } : null,
      pendencias: pendencias(db, e.id),
      hoje: totaisHoje,
      divergencias_abertas: db.prepare("SELECT COUNT(*) AS n FROM divergencias WHERE empresa_id = ? AND status = 'aberta'").get(e.id).n,
    });
  });

  r.use('/clientes', require('./clientes')(db));
  r.use('/caixa', require('./caixa')(db));
  r.use('/recebimentos', require('./recebimentos')(db));
  r.use('/cartao', require('./cartao')(db));
  r.use('/conferencia', require('./conferencia')(db));
  r.use('/cadastros', require('./cadastros')(db));
  r.use('/configuracoes', require('./configuracoes')(db));
  return r;
};
