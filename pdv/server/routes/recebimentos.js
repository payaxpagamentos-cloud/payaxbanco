'use strict';

const { Router } = require('express');
const recebimentos = require('../lib/recebimentos');
const { enviarRecebimento, marcarManual, estornarRecebimento } = require('../lib/baixas');
const { conferirRecebimento } = require('../lib/conferencia');
const { comprovante } = require('../lib/comprovante');
const { lerConfig, ixcPronto } = require('../lib/ixcEmpresa');
const { permitir, SUPERVISAO } = require('../auth');
const { registrar } = require('../lib/auditoria');
const { enviarCsv, reais } = require('../lib/csv');
const { hoje } = require('../lib/datas');
const v = require('../lib/validacao');

const OPERA = ['master', 'suporte', 'admin', 'operador'];
const FORMAS = { dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferência', outro: 'Outro' };
const SITUACAO_IXC = { pendente: 'Aguardando baixa', enviando: 'Enviando', baixado: 'Baixado no IXC', parcial: 'Baixa parcial', erro: 'Erro na baixa', manual: 'Baixa manual', avulso: 'Sem fatura', estornado: 'Estornado' };

/** Recebimentos do PDV (/api/empresas/:eid/recebimentos). */
module.exports = (db) => {
  const r = Router({ mergeParams: true });

  r.get('/', (req, res) => res.json(recebimentos.listar(db, req.empresa.id, req.query)));

  r.get('/exportar.csv', (req, res) => {
    const { itens } = recebimentos.listar(db, req.empresa.id, { ...req.query, limite: 500 });
    enviarCsv(res, `recebimentos-${req.query.de ?? hoje()}.csv`, [
      ['Nº', 'Data', 'Hora', 'Cliente', 'CPF/CNPJ', 'Código IXC', 'Loja', 'Operador', 'Origem', 'Formas', 'Títulos', 'Acréscimo', 'Desconto', 'Total', 'Situação', 'Baixa no IXC', 'Conferência'],
      ...itens.map((x) => [x.numero, x.data, String(x.criado_em).slice(11, 16), x.cliente_nome, x.cliente_documento ?? '', x.cliente_ixc_id ?? '',
        x.loja_nome, x.operador_nome, x.origem === 'autoatendimento' ? 'Tela do cliente' : 'Balcão', x.formas.map((f) => FORMAS[f] ?? f).join(' + '),
        reais(x.valor_titulos_centavos), reais(x.acrescimo_centavos), reais(x.desconto_centavos), reais(x.valor_centavos),
        x.status === 'cancelado' ? 'Cancelado' : 'Confirmado', SITUACAO_IXC[x.ixc_status] ?? x.ixc_status, x.conferencia]),
    ]);
  });

  r.get('/:id', (req, res) => res.json(recebimentos.detalhe(db, req.empresa.id, req.params.id)));

  r.get('/:id/comprovante', (req, res) => {
    const texto = comprovante(db, req.empresa, req.params.id, { colunas: req.query.colunas, via: req.query.via ?? 'Cliente' });
    if (req.query.formato === 'txt') {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      return res.send(texto);
    }
    res.json({ texto });
  });

  /**
   * Registra o recebimento. Quando a baixa automática está ligada, o PDV já tenta baixar no IXC;
   * se o IXC não responder, o recebimento fica registrado assim mesmo e a fila tenta de novo.
   */
  r.post('/', permitir(...OPERA), async (req, res) => {
    const criado = recebimentos.criar(db, { empresa: req.empresa, usuario: req.usuario, dados: req.body });
    registrar(db, req, 'recebimento', { recebimento: criado.id, numero: criado.numero, valor: criado.valor_centavos, cliente: criado.cliente_ixc_id });
    const cfg = lerConfig(db, req.empresa.id);
    let aviso = null;
    if (criado.ixc_status === 'pendente' && cfg.baixa_automatica && ixcPronto(db, req.empresa.id)) {
      try {
        const atualizado = await enviarRecebimento(db, req.empresa, criado.id);
        return res.status(201).json({ ...atualizado, aviso: atualizado.ixc_status === 'baixado' ? null : 'O IXC não confirmou a baixa. O recebimento está registrado e a baixa será tentada de novo.' });
      } catch (err) {
        aviso = `Recebimento registrado, mas a baixa no IXC falhou: ${err.message} O PDV vai tentar de novo.`;
        db.prepare("UPDATE recebimentos SET ixc_status = 'erro', ixc_erro = ? WHERE id = ?").run(String(err.message).slice(0, 300), criado.id);
      }
    } else if (criado.ixc_status === 'pendente' && !ixcPronto(db, req.empresa.id)) {
      aviso = 'IXC não configurado: o recebimento ficou registrado como pendente de baixa.';
    }
    res.status(201).json({ ...recebimentos.detalhe(db, req.empresa.id, criado.id), aviso });
  });

  r.post('/:id/cancelar', permitir(...SUPERVISAO), async (req, res) => {
    const cancelado = recebimentos.cancelar(db, { empresa: req.empresa, usuario: req.usuario, id: req.params.id, motivo: req.body.motivo });
    registrar(db, req, 'recebimento_cancelado', { recebimento: cancelado.id, numero: cancelado.numero, motivo: req.body.motivo });
    if (cancelado.estorno_ixc_necessario && ixcPronto(db, req.empresa.id)) {
      try {
        const estornado = await estornarRecebimento(db, req.empresa, cancelado.id);
        return res.json({ ...estornado, aviso: estornado.ixc_status === 'estornado' ? null : 'As faturas ainda não foram reabertas no IXC. O PDV vai tentar de novo.' });
      } catch (err) {
        return res.json({ ...recebimentos.detalhe(db, req.empresa.id, cancelado.id), aviso: `Cancelado no PDV, mas o estorno no IXC falhou: ${err.message}` });
      }
    }
    res.json(cancelado);
  });

  // Tentar a baixa agora (quando o IXC estava fora do ar ou a configuração foi corrigida).
  r.post('/:id/baixa', permitir(...SUPERVISAO, 'operador'), async (req, res) => {
    const atualizado = await enviarRecebimento(db, req.empresa, req.params.id);
    registrar(db, req, 'baixa_manual_tentativa', { recebimento: atualizado.id, situacao: atualizado.ixc_status });
    res.json(atualizado);
  });

  // Baixa feita à mão dentro do IXC: o PDV para de tentar e o recebimento sai da fila.
  r.post('/:id/baixa-manual', permitir(...SUPERVISAO), (req, res) => {
    const atualizado = marcarManual(db, { empresa: req.empresa, usuario: req.usuario, recebimentoId: req.params.id, motivo: req.body.motivo });
    registrar(db, req, 'baixa_marcada_manual', { recebimento: atualizado.id, motivo: req.body.motivo });
    res.json(atualizado);
  });

  r.post('/:id/conferir', permitir(...SUPERVISAO), async (req, res) => {
    const atualizado = await conferirRecebimento(db, req.empresa, req.params.id, { usuarioId: req.usuario.id });
    res.json(atualizado);
  });

  // Observação do atendimento (quem recebeu pode completar depois de impresso).
  r.patch('/:id', permitir(...OPERA, 'supervisor'), (req, res) => {
    const x = recebimentos.buscar(db, req.empresa.id, req.params.id);
    db.prepare('UPDATE recebimentos SET observacao = ? WHERE id = ?').run(v.opcional(req.body.observacao, 'a observação', 300), x.id);
    res.json(recebimentos.detalhe(db, req.empresa.id, x.id));
  });

  return r;
};
