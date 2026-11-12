'use strict';

const { Router } = require('express');
const auto = require('../lib/autoatendimento');
const { buscar: buscarCobranca, cancelar: cancelarCobranca } = require('../lib/maquininha');
const { enviarRecebimento } = require('../lib/baixas');
const { comprovante } = require('../lib/comprovante');
const { ixcPronto } = require('../lib/ixcEmpresa');
const { limitar } = require('../lib/limitador');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');

/**
 * API da tela do cliente (/api/autoatendimento), autenticada pela chave do PDV:
 *   X-Api-Key: pdv_<prefixo>_<segredo>
 *
 * A tela só consulta faturas pelo CPF/CNPJ completo e só cobra no cartão/PIX pela maquininha do PDV.
 * Não há cancelamento, desconto nem dinheiro aqui: isso é do balcão.
 */
module.exports = (db) => {
  const r = Router();

  // Consulta de CPF/CNPJ é limitada por aparelho para ninguém ficar "pescando" documentos.
  r.use('/faturas', limitar({ janelaMs: 60_000, maximo: 20 }));

  r.use((req, _res, next) => {
    const chave = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const achado = auto.lerChave(db, chave);
    if (!achado) return next(new ErroNegocio('Esta tela não está ativada. Peça ao administrador a chave do PDV.', 401));
    req.tela = achado;
    req.empresa = achado.empresa;
    next();
  });

  // Marca, loja e formas de pagamento da tela.
  r.get('/', (req, res) => res.json(auto.abertura(db, req.tela)));

  // O cliente digitou o CPF/CNPJ.
  r.post('/faturas', async (req, res) => {
    if (!ixcPronto(db, req.empresa.id)) throw new ErroNegocio('A consulta de faturas está indisponível. Procure o atendente.', 503);
    res.json(await auto.faturas(db, req.tela, req.body.documento));
  });

  // Manda a maquininha cobrar.
  r.post('/cobrancas', async (req, res) => {
    const cobranca = await auto.cobrarNaMaquininha(db, req.tela, {
      forma: req.body.forma, valorCentavos: req.body.valor_centavos, parcelas: req.body.parcelas ?? 1,
    });
    registrar(db, { usuario: req.tela.usuario, ip: req.ip }, 'autoatendimento_cobranca',
      { pdv: req.tela.pdv.id, transacao: cobranca.id, valor: cobranca.valor_centavos, forma: cobranca.forma }, req.empresa.id);
    res.status(201).json(cobranca);
  });

  r.get('/cobrancas/:id', (req, res) => res.json(buscarCobranca(db, req.empresa.id, req.params.id)));

  r.post('/cobrancas/:id/cancelar', (req, res) => res.json(cancelarCobranca(db, req.empresa.id, req.params.id)));

  // Cobrança aprovada: grava o recebimento, baixa no IXC e devolve o recibo para a tela mostrar.
  r.post('/recebimentos', async (req, res) => {
    const recebimento = await auto.receber(db, req.tela, req.body);
    registrar(db, { usuario: req.tela.usuario, ip: req.ip }, 'autoatendimento_recebimento',
      { pdv: req.tela.pdv.id, recebimento: recebimento.id, numero: recebimento.numero, valor: recebimento.valor_centavos }, req.empresa.id);
    let atual = recebimento;
    if (atual.ixc_status === 'pendente' && ixcPronto(db, req.empresa.id)) {
      // Se o IXC não responder, o recebimento fica registrado e a fila baixa depois: o cliente não espera por isso.
      try { atual = await enviarRecebimento(db, req.empresa, recebimento.id); } catch { /* a fila tenta de novo */ }
    }
    res.status(201).json({
      id: atual.id,
      numero: atual.numero,
      valor_centavos: atual.valor_centavos,
      criado_em: atual.criado_em,
      cliente_nome: auto.mascararNome(atual.cliente_nome),
      titulos: atual.titulos.map((t) => ({ fatura_ixc_id: t.fatura_ixc_id, vencimento: t.vencimento, total_centavos: t.total_centavos })),
      pagamento: atual.pagamentos.map((p) => ({ forma: p.forma, parcelas: p.parcelas, bandeira: p.bandeira, nsu: p.nsu })),
      comprovante: comprovante(db, req.empresa, atual.id, { colunas: 42, via: 'Cliente' }),
    });
  });

  return r;
};
