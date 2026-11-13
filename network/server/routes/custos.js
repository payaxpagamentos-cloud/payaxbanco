'use strict';

const { Router } = require('express');
const { exigir } = require('../auth');
const atendimento = require('../conectores/atendimento');

/**
 * O custo do WhatsApp dentro do Manager.
 *
 * O número é produzido no ZOE Atende e lido aqui pelo conector. Esta rota só entrega o que já foi
 * lido — não chama o ZOE Atende na hora — para a tela abrir rápido e para uma queda lá não derrubar
 * o painel da gestão. A idade do dado vem junto, em `atualizado_em`, para ninguém olhar número velho
 * achando que é de agora.
 */
module.exports = (db) => {
  const r = Router();

  r.get('/whatsapp', exigir('painel.ver'), (req, res) => {
    const meses = Math.min(60, Math.max(1, Number(req.query.meses) || 12));
    const d = atendimento.ler(db, req.org, { meses });
    const fechados = d.meses.filter((m) => !m.em_aberto);
    res.json({
      ...d,
      // O resumo que a gestão quer sem ter que somar nada: 12 meses de conta e de economia.
      acumulado: {
        meses: fechados.length,
        gasto_centavos: fechados.reduce((s, m) => s + Number(m.gasto_centavos), 0),
        economia_centavos: fechados.reduce((s, m) => s + Number(m.economia_centavos), 0),
        sem_otimizacao_centavos: fechados.reduce((s, m) => s + Number(m.sem_otimizacao_centavos), 0),
        divergentes: fechados.filter((m) => m.divergente).length,
        conferidos: fechados.filter((m) => m.fatura_meta_centavos !== null).length,
      },
    });
  });

  return r;
};
