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
const repassesLib = require('../lib/repasses');
const sincronismo = require('../lib/sincronismo');
const datas = require('../lib/datas');
const { assinaturaFicha } = require('./boletos');
const abertura = require('../lib/abertura');
const ativacao = require('../lib/ativacao');
const auditoria = require('../lib/auditoria');
const consultaDados = require('../lib/consultaDados');
const { limitar } = require('../lib/limitador');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const igual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Valor do aviso em centavos inteiros, aceitando as formas que os bancos usam:
 *   "1.234,56" (pt-BR) · "1234.56" (ponto decimal) · "123456" (texto só de dígitos = centavos) · 1234.56 ou 150 (número = reais).
 */
function valorEmCentavos(v) {
  if (v === undefined || v === null || v === '') return 0;
  // Número JSON é sempre reais (150 = R$ 150,00; 150.5 = R$ 150,50). Centavos só vêm como texto só de dígitos.
  if (typeof v === 'number') return Math.round(v * 100);
  const t = String(v).trim().replace(/^R\$\s*/, '');
  if (t.includes(',')) return Math.round(Number(t.replace(/\./g, '').replace(',', '.')) * 100) || 0;
  if (/\.\d{1,2}$/.test(t)) return Math.round(Number(t) * 100) || 0;
  return Math.round(Number(t.replace(/\./g, ''))) || 0;
}

/** Extrai nosso número, valor e data de pagamento de um aviso do banco, aceitando as variações de nome de campo. */
function lerAviso(p) {
  const pega = (...nomes) => nomes.map((n) => p?.[n]).find((x) => x !== undefined && x !== null && x !== '');
  const nossoNumero = String(pega('nossoNumero', 'nosso_numero', 'eNumeroTitulo', 'numeroTitulo', 'identificacaoBoleto') ?? '').replace(/\D/g, '');
  // Só campos de VALOR PAGO: "valor" sozinho costuma ser o valor do título, não o que foi pago.
  const centavos = valorEmCentavos(pega('valorPago', 'vlPagoTitulo', 'valor_pago'));
  const lerData = (bruta) => {
    const t = String(bruta ?? '');
    return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10)
      : /^\d{2}[./]\d{2}[./]\d{4}$/.test(t) ? t.replace(/\./g, '/').split('/').reverse().join('-') : null;
  };
  // Data do pagamento e data do crédito são coisas diferentes: o crédito decide quando o dinheiro libera.
  const creditadoEm = lerData(pega('dataCredito', 'dtCreditoTitulo', 'data_credito'));
  const dataPagamento = lerData(pega('dataPagamento', 'dtPagamento', 'data_pagamento', 'dataLiquidacao', 'dtLiquidacao', 'pago_em')) ?? creditadoEm;
  // Sem tipo de evento não se presume pagamento.
  const evento = String(pega('evento', 'tipoEvento', 'tipo') ?? '').toLowerCase();
  const situacao = String(pega('situacao', 'status', 'situacaoTitulo') ?? '').toLowerCase();
  // Meio de pagamento: só nos campos que dizem isso. Procurar "pix" no aviso inteiro confundia o tipo do
  // título (BOLEPIX) com o meio usado — e PIX libera no mesmo dia, antes de o banco creditar.
  const meio = /pix|qr/i.test(String(pega('meioPagamento', 'meio_pagamento', 'tipoPagamento', 'formaPagamento', 'canalPagamento', 'meio') ?? '')) ? 'pix' : 'boleto';
  return { nosso_numero: nossoNumero, valor_centavos: centavos, pago_em: dataPagamento, creditado_em: creditadoEm, evento, situacao, meio };
}

/**
 * O aviso é de PAGAMENTO? Só com evento de liquidação explícito (ou, sem evento, com valor pago e data de
 * pagamento) e sem nenhuma palavra que indique o contrário (estorno, cancelamento, aguardando, registro...).
 */
function ehPagamento(aviso) {
  const negativo = /estorn|cancel|aguard|pendent|registr|rejeit|devol|baixa_(manual|por_decurso|solicit)|vencid|protest/;
  if (negativo.test(aviso.evento) || negativo.test(aviso.situacao)) return false;
  if (aviso.evento) return /liquid|^pago$|pagamento_(confirmado|efetuado|realizado|recebido)|baixa_por_pagamento|credito/.test(aviso.evento);
  return aviso.valor_centavos > 0 && Boolean(aviso.pago_em) && (!aviso.situacao || /pago|liquid/.test(aviso.situacao));
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
      // O aviso é da conta desta integração: o mesmo nosso número pode existir em outro convênio.
      const achados = db.prepare(`SELECT * FROM boletos WHERE nosso_numero = ? ${i?.conta_id ? 'AND conta_id = ?' : ''} ORDER BY id DESC`)
        .all(...[aviso.nosso_numero.padStart(11, '0'), ...(i?.conta_id ? [i.conta_id] : [])]);
      // Sem conta definida e o número existe em mais de uma: não adivinha qual cliente pagou.
      if (achados.length > 1) {
        concluir('erro', `nosso número ${aviso.nosso_numero} existe em ${achados.length} contas: conferir no banco e liquidar pela ficha do boleto`);
        return res.json({ recebido: true, processado: false });
      }
      const b = achados[0];
      if (!b) { concluir('ignorado', 'título não encontrado'); return res.json({ recebido: true, processado: false }); }
      // Valor fora de qualquer proporção com o título (ex.: reais lidos como centavos): não liquida no automático.
      if (aviso.valor_centavos > 0 && (aviso.valor_centavos * 20 < b.valor_centavos || aviso.valor_centavos > b.valor_centavos * 20)) {
        concluir('erro', `valor do aviso (${aviso.valor_centavos} centavos) incompatível com o título (${b.valor_centavos}): conferir`, b.id);
        return res.json({ recebido: true, processado: false });
      }
      if (!ehPagamento(aviso)) {
        concluir('ignorado', aviso.evento ? `evento ${aviso.evento} não é pagamento` : 'aviso sem tipo de evento e sem valor/data de pagamento', b.id);
        return res.json({ recebido: true, processado: false });
      }
      // Liquidação já estornada pela equipe: um aviso repetido do banco não pode creditar de novo.
      if (b.situacao !== 'liquidado' && boletosLib.temEstorno(db, b.id)) {
        concluir('erro', 'título com liquidação estornada: conferir no banco e liquidar pela ficha, se for o caso', b.id);
        return res.json({ recebido: true, processado: false });
      }

      const out = boletosLib.liquidar(db, b.id, {
        pago_em: aviso.pago_em ?? hoje(),
        creditado_em: aviso.creditado_em ?? null,
        valor_pago_centavos: aviso.valor_centavos > 0 ? aviso.valor_centavos : b.valor_centavos,
        meio: aviso.meio,
      }, { origem: 'webhook' });
      concluir(out.ja_liquidado ? 'repetido' : 'liquidado', null, b.id);
      if (!out.ja_liquidado) {
        sincronismo.avisarBaixa(db, b.id).catch(() => null);
        // Crédito já na conta (PIX): o cliente recebe agora. Senão, a rotina repassa no dia do crédito.
        repassesLib.repassarCliente(db, b.cliente_id).catch(() => null);
      }
      res.json({ recebido: true, processado: !out.ja_liquidado });
    } catch (err) {
      concluir('erro', String(err.message).slice(0, 300), null);
      res.status(200).json({ recebido: true, processado: false, erro: err.message });
    }
  });

  // ------------------------------------------------------------ Abertura de conta pelo site
  // Até 5 pedidos por IP a cada 10 minutos; a consulta de CNPJ/CEP só pela fonte gratuita, 20 por minuto.
  const consultasPorIp = new Map();
  const limiteConsulta = (req, _res, next) => {
    const n = Date.now();
    const t = (consultasPorIp.get(req.ip) ?? []).filter((x) => x > n - 60_000);
    t.push(n);
    consultasPorIp.set(req.ip, t);
    if (consultasPorIp.size > 5000) consultasPorIp.clear();
    if (t.length > 20) return next(new ErroNegocio('Muitas consultas seguidas. Aguarde um instante.', 429));
    next();
  };
  r.get('/abertura/cnpj/:cnpj', limiteConsulta, async (req, res) => {
    const d = await consultaDados.consultarCnpj(db, req.params.cnpj, { somentePublica: true });
    // Só o que preenche o formulário: sócios e dados de terceiros não saem por aqui.
    res.json({ cnpj: d.cnpj, razao_social: d.razao_social, nome_fantasia: d.nome_fantasia, email: d.email, telefone: d.telefone,
      cep: d.cep, endereco: d.endereco, numero: d.numero, complemento: d.complemento, bairro: d.bairro, cidade: d.cidade, uf: d.uf,
      situacao: d.situacao ?? null });
  });
  r.get('/abertura/cep/:cep', limiteConsulta, async (req, res) => res.json(await consultaDados.consultarCep(db, req.params.cep, { somentePublica: true })));
  // O limite de pedidos por IP fica em app.js, antes da leitura do corpo.
  r.post('/abertura', (req, res) => {
    const { corpoCliente } = require('./clientes');
    const out = abertura.solicitar(db, req.body ?? {}, { ip: req.ip, validarCadastro: (d) => corpoCliente(d, { novo: true }) });
    res.status(201).json({ protocolo: out.protocolo });
    // SMS com o protocolo depois da resposta: a operadora lenta não segura a tela do cliente.
    abertura.avisarProtocolo(db, out.id).catch((err) => console.error('[PAY AX] SMS do protocolo:', err.message));
  });

  // ------------------------------------------------------------ Ativação do acesso (acesso.payax.com.br)
  // O código do link vem no corpo (nunca no endereço). Limite por IP contra tentativa e erro.
  const limiteAtivacao = limitar({ janelaMs: 10 * 60_000, maximo: config.limiteAtivacaoPor10Min });
  r.post('/ativacao/consultar', limiteAtivacao, (req, res) => res.json(ativacao.consultar(db, req.body?.token)));
  r.post('/ativacao', limiteAtivacao, (req, res) => {
    const out = ativacao.ativar(db, req.body?.token, { cnpj: req.body?.cnpj, senha: req.body?.senha, ip: req.ip });
    auditoria.registrar(db, req, { acao: 'acesso.ativado', entidade: 'usuario_cliente', entidade_id: out.usuario_cliente_id, cliente_id: out.cliente_id,
      depois: { codigo_usuario: out.codigo_usuario } });
    res.json({ codigo_usuario: out.codigo_usuario, entrar_em: out.entrar_em });
  });

  return r;
};

module.exports.lerAviso = lerAviso;
module.exports.ehPagamento = ehPagamento;
module.exports.valorEmCentavos = valorEmCentavos;
