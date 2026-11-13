'use strict';

const express = require('express');
const config = require('../config');
const { naoEncontrado, ErroNegocio } = require('../lib/erros');
const { exigir } = require('../auth');
const { csv } = require('../lib/http');
const v = require('../lib/validacao');
const datas = require('../lib/datas');
const boletosLib = require('../lib/boletos');
const precos = require('../lib/precos');
const consultas = require('../lib/consultas');
const impressao = require('../lib/impressao');
const { formatarNossoNumero, formatarLinha } = require('../lib/febraban');
const { assinar } = require('../lib/cripto');
const auditoria = require('../lib/auditoria');
const ixcLib = require('../lib/sincronismo');

const hoje = () => datas.dataLocal(config.fusoPadrao);

/** Link público da ficha (o pagador abre sem login). Assinado: só vale para aquele boleto. */
const assinaturaFicha = (id, nossoNumero) => assinar(`ficha:${id}:${nossoNumero}`).slice(0, 32);

module.exports = (db) => {
  const r = express.Router();

  r.get('/', exigir('boletos.ver'), (req, res) => res.json(consultas.listarBoletos(db, req.query, hoje())));

  r.get('/export.csv', exigir('boletos.ver'), (req, res) => {
    const lista = consultas.listarBoletos(db, { ...req.query, por_pagina: 10000 }, hoje());
    const linhas = [['Cliente', 'Nosso número', 'Documento', 'Pagador', 'CPF/CNPJ', 'Emissão', 'Vencimento', 'Valor (R$)', 'Situação', 'Pago em', 'Valor pago (R$)']];
    for (const b of lista.itens) {
      linhas.push([b.razao_social, b.nosso_numero_formatado, b.seu_numero ?? '', b.pagador_nome, b.pagador_documento,
        b.emissao, b.vencimento, (b.valor_centavos / 100).toFixed(2).replace('.', ','), b.situacao_visivel,
        b.pago_em ?? '', b.pago_valor_centavos ? (b.pago_valor_centavos / 100).toFixed(2).replace('.', ',') : '']);
    }
    res.type('text/csv; charset=utf-8').attachment(`boletos-${hoje()}.csv`).send(csv(linhas));
  });

  /** Mostra como ficaria o split antes de emitir. */
  r.post('/simular', exigir('boletos.ver'), (req, res) => {
    const clienteId = Number(req.body?.cliente_id);
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
    if (!cliente) throw naoEncontrado('Cliente');
    res.json(precos.simular(db, cliente.id, v.centavos(req.body?.valor, 'o valor'), hoje()));
  });

  r.post('/', exigir('boletos.emitir'), async (req, res) => {
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(req.body?.cliente_id));
    if (!cliente) throw naoEncontrado('Cliente');
    const out = await boletosLib.emitir(db, { cliente, dados: req.body ?? {}, usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'boleto.emitido', entidade: 'boleto', entidade_id: out.id, cliente_id: cliente.id,
      depois: { valor: req.body?.valor, vencimento: req.body?.vencimento, pagador: req.body?.pagador_nome, situacao: out.situacao } });
    res.status(201).json(detalhe(db, out.id));
  });

  r.get('/:id', exigir('boletos.ver'), (req, res) => res.json(detalhe(db, req.params.id)));

  /** Ficha de compensação para imprimir (também usada pelo link público). */
  r.get('/:id/ficha', exigir('boletos.ver'), async (req, res) => {
    const d = consultas.boletoCompleto(db, req.params.id);
    if (!d) throw naoEncontrado('Boleto');
    res.type('html').send(await impressao.fichaCompensacao({ ...d, hoje: hoje(), base: config.basePath }));
  });

  r.get('/:id/link', exigir('boletos.ver'), (req, res) => {
    const b = db.prepare('SELECT id, nosso_numero FROM boletos WHERE id = ?').get(Number(req.params.id));
    if (!b) throw naoEncontrado('Boleto');
    const caminho = `${config.basePath}/api/publico/boleto/${b.id}/${assinaturaFicha(b.id, b.nosso_numero)}`;
    res.json({ caminho, url: config.urlPublica ? `${config.urlPublica}${caminho}` : null });
  });

  r.post('/:id/baixa', exigir('boletos.baixar'), async (req, res) => {
    const motivo = v.texto(req.body?.motivo, 'o motivo da baixa', 160);
    const out = await boletosLib.baixar(db, Number(req.params.id), motivo, { usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'boleto.baixado', entidade: 'boleto', entidade_id: Number(req.params.id), depois: { motivo } });
    res.json(out);
  });

  /** Baixa manual (conciliação): usada quando o crédito chega por fora do aviso automático. */
  r.post('/:id/liquidar', exigir('conciliacao.operar'), async (req, res) => {
    const out = boletosLib.liquidar(db, Number(req.params.id), {
      pago_em: v.data(req.body?.pago_em ?? hoje(), 'a data do pagamento'),
      valor_pago_centavos: v.centavos(req.body?.valor_pago, 'o valor pago'),
      juros_centavos: v.centavosOpcional(req.body?.juros, 'os juros') ?? 0,
      desconto_centavos: v.centavosOpcional(req.body?.desconto, 'o desconto') ?? 0,
      meio: req.body?.meio === 'pix' ? 'pix' : 'boleto',
    }, { usuario: req.usuario, origem: 'manual' });
    auditoria.registrar(db, req, { acao: 'boleto.liquidado.manual', entidade: 'boleto', entidade_id: Number(req.params.id), depois: out });
    if (!out.ja_liquidado) await ixcLib.avisarBaixa(db, Number(req.params.id)).catch(() => null);
    res.json(out);
  });

  r.post('/:id/estorno', exigir('conciliacao.operar'), (req, res) => {
    const motivo = v.texto(req.body?.motivo, 'o motivo do estorno', 160);
    const out = boletosLib.estornarLiquidacao(db, Number(req.params.id), motivo, req.usuario);
    auditoria.registrar(db, req, { acao: 'boleto.estornado', entidade: 'boleto', entidade_id: Number(req.params.id), depois: { motivo } });
    res.json(out);
  });

  /** Pergunta ao banco a situação do título (reconcilia um título em falha ou duvidoso). */
  r.post('/:id/consultar', exigir('conciliacao.operar'), async (req, res) => {
    const d = consultas.boletoCompleto(db, req.params.id);
    if (!d) throw naoEncontrado('Boleto');
    const { criarBanco } = require('../lib/bradesco');
    const banco = criarBanco(d.conta, boletosLib.credenciaisDaConta(db, d.conta.id));
    const resp = await banco.consultar(d.boleto.nosso_numero);
    if (resp.situacao === 'liquidado' && d.boleto.situacao !== 'liquidado') {
      boletosLib.liquidar(db, d.boleto.id, {
        pago_em: resp.pago_em ?? hoje(),
        valor_pago_centavos: resp.pago_valor_centavos ?? d.boleto.valor_centavos,
      }, { usuario: req.usuario, origem: 'consulta' });
      await ixcLib.avisarBaixa(db, d.boleto.id).catch(() => null);
    }
    res.json({ consulta: resp, boleto: detalhe(db, d.boleto.id) });
  });

  return r;
};

/** Detalhe do boleto como as telas esperam. */
function detalhe(db, id, clienteId = null) {
  const d = consultas.boletoCompleto(db, id, { clienteId });
  if (!d) throw naoEncontrado('Boleto');
  const data = hoje();
  const split = d.boleto.situacao === 'liquidado'
    ? precos.calcularSplit({ valorPagoCentavos: d.boleto.pago_valor_centavos, preco: precos.doBoleto(d.boleto), custoLiquidacaoCentavos: d.boleto.custo_liquidacao_centavos })
    : precos.calcularSplit({ valorPagoCentavos: d.boleto.valor_centavos, preco: precos.doBoleto(d.boleto), custoLiquidacaoCentavos: d.boleto.custo_liquidacao_centavos });
  return {
    ...d.boleto,
    situacao_visivel: boletosLib.situacaoVisivel(d.boleto, data),
    nosso_numero_formatado: formatarNossoNumero(d.boleto.nosso_numero, d.boleto.nosso_numero_dv),
    linha_formatada: formatarLinha(d.boleto.linha_digitavel ?? ''),
    atualizado: boletosLib.valorAtualizado(d.boleto, data),
    split: { ...split, previsto: d.boleto.situacao !== 'liquidado' },
    cliente: { id: d.cliente.id, razao_social: d.cliente.razao_social, nome_fantasia: d.cliente.nome_fantasia, cnpj: d.cliente.cnpj },
    conta: { id: d.conta.id, apelido: d.conta.apelido, banco: d.conta.banco, agencia: d.conta.agencia, conta: d.conta.conta, carteira: d.conta.carteira },
    lancamentos: d.lancamentos,
  };
}

module.exports.detalhe = detalhe;
module.exports.assinaturaFicha = assinaturaFicha;
