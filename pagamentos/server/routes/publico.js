'use strict';

/*
 * Rotas sem sessão:
 *   - aviso do banco (webhook de liquidação), autenticado por um token próprio;
 *   - ficha de compensação por link assinado, para o pagador abrir e imprimir.
 */
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const consultas = require('../lib/consultas');
const impressao = require('../lib/impressao');
const boletosLib = require('../lib/boletos');
const sincronismo = require('../lib/sincronismo');
const datas = require('../lib/datas');
const { assinaturaFicha } = require('./boletos');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const igual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Valor do aviso em centavos inteiros, aceitando as formas que os bancos usam:
 *   "1.234,56" (pt-BR) · "1234.56" (ponto decimal) · 123456 ou "123456" (centavos) · 1234.56 (número).
 */
function valorEmCentavos(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 100);
  const t = String(v).trim().replace(/^R\$\s*/, '');
  if (t.includes(',')) return Math.round(Number(t.replace(/\./g, '').replace(',', '.')) * 100) || 0;
  if (/\.\d{1,2}$/.test(t)) return Math.round(Number(t) * 100) || 0;
  return Math.round(Number(t.replace(/\./g, ''))) || 0;
}

/** Extrai nosso número, valor e data de pagamento de um aviso do banco, aceitando as variações de nome de campo. */
function lerAviso(p) {
  const pega = (...nomes) => nomes.map((n) => p?.[n]).find((x) => x !== undefined && x !== null && x !== '');
  const nossoNumero = String(pega('nossoNumero', 'nosso_numero', 'eNumeroTitulo', 'numeroTitulo', 'identificacaoBoleto') ?? '').replace(/\D/g, '');
  const centavos = valorEmCentavos(pega('valorPago', 'vlPagoTitulo', 'valor_pago', 'valor'));
  const dataBruta = String(pega('dataCredito', 'dtCreditoTitulo', 'data_pagamento', 'dataPagamento', 'pago_em') ?? '');
  const dataPagamento = /^\d{4}-\d{2}-\d{2}/.test(dataBruta) ? dataBruta.slice(0, 10)
    : /^\d{2}[./]\d{2}[./]\d{4}$/.test(dataBruta) ? dataBruta.replace(/\./g, '/').split('/').reverse().join('-')
      : null;
  const evento = String(pega('evento', 'tipoEvento', 'tipo') ?? 'liquidacao').toLowerCase();
  return { nosso_numero: nossoNumero, valor_centavos: centavos, pago_em: dataPagamento, evento, meio: /pix|qr/i.test(JSON.stringify(p ?? {})) ? 'pix' : 'boleto' };
}

module.exports = (db) => {
  const r = express.Router();

  /** Ficha de compensação pelo link assinado (o pagador não tem login). */
  r.get('/boleto/:id/:assinatura', async (req, res) => {
    const d = consultas.boletoCompleto(db, req.params.id);
    if (!d) throw naoEncontrado('Boleto');
    if (!igual(req.params.assinatura, assinaturaFicha(d.boleto.id, d.boleto.nosso_numero))) {
      throw new ErroNegocio('Link inválido ou expirado.', 403);
    }
    if (d.boleto.situacao === 'cancelado') throw new ErroNegocio('Este boleto foi cancelado.', 410);
    res.set('Cache-Control', 'private, no-store');
    res.type('html').send(await impressao.fichaCompensacao({ ...d, hoje: hoje(), base: config.basePath }));
  });

  /**
   * Aviso de liquidação do banco. O token vem na URL (é o que o Bradesco permite cadastrar);
   * o corpo inteiro é guardado em eventos_banco antes de qualquer processamento, para auditoria e reprocesso.
   */
  r.post('/webhook/:token', async (req, res) => {
    const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'banco' ORDER BY id LIMIT 1").get();
    const esperado = JSON.parse(i?.config || '{}').webhook_token;
    if (!esperado || !igual(req.params.token, esperado)) throw new ErroNegocio('Token do webhook inválido.', 403);

    const payload = req.body ?? {};
    const aviso = lerAviso(payload);
    const eventoId = db.prepare(`INSERT INTO eventos_banco (conta_id, tipo, nosso_numero, payload, origem, recebido_em)
      VALUES (?, ?, ?, ?, 'webhook', ?) RETURNING id`)
      .get(i?.conta_id ?? null, aviso.evento, aviso.nosso_numero || null, JSON.stringify(payload).slice(0, 20000), agora()).id;

    // Responde rápido ao banco: o aviso já está guardado e será processado mesmo se algo falhar aqui.
    const concluir = (resultado, erro = null, boletoId = null) => db.prepare('UPDATE eventos_banco SET processado_em = ?, resultado = ?, erro = ?, boleto_id = ? WHERE id = ?')
      .run(agora(), resultado, erro, boletoId, eventoId);

    try {
      if (!aviso.nosso_numero) { concluir('ignorado', 'aviso sem nosso número'); return res.json({ recebido: true, processado: false }); }
      const b = db.prepare('SELECT * FROM boletos WHERE nosso_numero = ? ORDER BY id DESC LIMIT 1').get(aviso.nosso_numero.padStart(11, '0'));
      if (!b) { concluir('ignorado', 'título não encontrado'); return res.json({ recebido: true, processado: false }); }
      if (!/liquid|pag|credit|baixa_por_pagamento/i.test(aviso.evento)) { concluir('ignorado', `evento ${aviso.evento}`, b.id); return res.json({ recebido: true, processado: false }); }

      const out = boletosLib.liquidar(db, b.id, {
        pago_em: aviso.pago_em ?? hoje(),
        valor_pago_centavos: aviso.valor_centavos > 0 ? aviso.valor_centavos : b.valor_centavos,
        meio: aviso.meio,
      }, { origem: 'webhook' });
      concluir(out.ja_liquidado ? 'repetido' : 'liquidado', null, b.id);
      if (!out.ja_liquidado) sincronismo.avisarBaixa(db, b.id).catch(() => null);
      res.json({ recebido: true, processado: !out.ja_liquidado });
    } catch (err) {
      concluir('erro', String(err.message).slice(0, 300), null);
      res.status(200).json({ recebido: true, processado: false, erro: err.message });
    }
  });

  return r;
};

module.exports.lerAviso = lerAviso;
module.exports.valorEmCentavos = valorEmCentavos;
