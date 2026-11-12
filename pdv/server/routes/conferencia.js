'use strict';

const { Router } = require('express');
const conferencia = require('../lib/conferencia');
const { processarFila, pendencias } = require('../lib/baixas');
const { listar } = require('../lib/recebimentos');
const { permitir, SUPERVISAO } = require('../auth');
const { registrar } = require('../lib/auditoria');
const { enviarCsv, reais } = require('../lib/csv');
const { hoje } = require('../lib/datas');

const TIPOS = conferencia.TIPOS;

/**
 * Conferência do que foi recebido no PDV com o que está no IXC (/api/empresas/:eid/conferencia).
 * Mostra o período fechado por forma de pagamento, por operador e por maquininha, e lista o que não bateu.
 */
module.exports = (db) => {
  const r = Router({ mergeParams: true });

  r.get('/', (req, res) => res.json({
    ...conferencia.resumo(db, req.empresa.id, req.query),
    pendencias: pendencias(db, req.empresa.id),
    tipos: TIPOS,
  }));

  r.get('/divergencias', (req, res) => res.json({ itens: conferencia.listarDivergencias(db, req.empresa.id, req.query), tipos: TIPOS }));

  // Confere no IXC, fatura por fatura, tudo o que o PDV recebeu no período.
  r.post('/conferir', permitir(...SUPERVISAO), async (req, res) => {
    const resultado = await conferencia.conferirPeriodo(db, req.empresa, {
      de: req.body.de, ate: req.body.ate, usuarioId: req.usuario.id, limite: req.body.limite, somentePendentes: req.body.somente_pendentes !== false,
    });
    registrar(db, req, 'conferencia', resultado);
    res.json(resultado);
  });

  // Empurra a fila de baixas agora (sem esperar a rodada automática).
  r.post('/fila', permitir(...SUPERVISAO), async (req, res) => {
    const resultado = await processarFila(db, { empresaId: req.empresa.id, limite: 50 });
    registrar(db, req, 'fila_baixas', resultado);
    res.json({ ...resultado, pendencias: pendencias(db, req.empresa.id) });
  });

  r.post('/divergencias/:id/resolver', permitir(...SUPERVISAO), (req, res) => {
    const d = conferencia.resolverDivergencia(db, {
      empresa: req.empresa, usuario: req.usuario, id: req.params.id, status: req.body.status ?? 'resolvida', resolucao: req.body.resolucao,
    });
    registrar(db, req, 'divergencia_resolvida', { divergencia: d.id, tipo: d.tipo, status: d.status });
    res.json(d);
  });

  // Planilha da conferência: uma linha por fatura recebida, com o que o IXC devolveu.
  r.get('/exportar.csv', (req, res) => {
    const de = req.query.de ?? hoje();
    const ate = req.query.ate ?? de;
    const linhas = db.prepare(`SELECT r.numero, r.data, r.cliente_nome, r.cliente_documento, r.cliente_ixc_id, r.status, r.ixc_status, r.conferencia,
        u.nome AS operador, l.nome AS loja, t.fatura_ixc_id, t.vencimento, t.valor_centavos, t.acrescimo_centavos, t.desconto_centavos, t.total_centavos,
        t.ixc_status AS titulo_status, t.ixc_situacao, t.ixc_valor_centavos, t.ixc_data_pagamento, t.ixc_erro
      FROM recebimentos r JOIN recebimento_titulos t ON t.recebimento_id = r.id
      JOIN usuarios u ON u.id = r.operador_id JOIN lojas l ON l.id = r.loja_id
      WHERE r.empresa_id = ? AND r.data >= ? AND r.data <= ? ORDER BY r.numero, t.id`).all(req.empresa.id, de, ate);
    enviarCsv(res, `conferencia-ixc-${de}_${ate}.csv`, [
      ['Recebimento', 'Data', 'Loja', 'Operador', 'Cliente', 'CPF/CNPJ', 'Código IXC', 'Fatura IXC', 'Vencimento', 'Valor', 'Multa e juros', 'Desconto', 'Total PDV',
        'Baixa', 'Situação no IXC', 'Valor no IXC', 'Pagamento no IXC', 'Diferença', 'Recebimento', 'Conferência', 'Erro'],
      ...linhas.map((x) => [x.numero, x.data, x.loja, x.operador, x.cliente_nome, x.cliente_documento ?? '', x.cliente_ixc_id ?? '',
        x.fatura_ixc_id ?? '', x.vencimento ?? '', reais(x.valor_centavos), reais(x.acrescimo_centavos), reais(x.desconto_centavos), reais(x.total_centavos),
        x.titulo_status, x.ixc_situacao ?? '', x.ixc_valor_centavos === null ? '' : reais(x.ixc_valor_centavos), x.ixc_data_pagamento ?? '',
        x.ixc_valor_centavos === null ? '' : reais(x.ixc_valor_centavos - x.total_centavos),
        x.status === 'cancelado' ? 'Cancelado' : 'Confirmado', x.conferencia, x.ixc_erro ?? '']),
    ]);
  });

  // Lista pronta para a tela: recebimentos do período com a situação da baixa.
  r.get('/recebimentos', (req, res) => res.json(listar(db, req.empresa.id, { ...req.query, limite: req.query.limite ?? 200 })));

  return r;
};
