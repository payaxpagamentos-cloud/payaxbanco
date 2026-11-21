'use strict';

const { transacao, agora } = require('../../db');
const { ErroNegocio } = require('../erros');
const { dataLocal } = require('../datas');
const certificado = require('../certificado');
const assinaturaXml = require('./assinatura');
const chaveAcesso = require('./chave');
const t = require('./tabelas');
const n = require('./nfcom');
const x = require('./xml');

/*
 * Emissão da NFCom: da fatura ao XML assinado.
 *
 * A ordem importa, e é esta:
 *   1. conferir que dá para emitir  — e, se não der, dizer o que falta
 *   2. montar os itens e os totais
 *   3. RESERVAR o número, numa transação
 *   4. montar o XML e assinar
 *   5. gravar
 *
 * O número é reservado antes da assinatura e nunca é devolvido ao estoque, mesmo se os passos seguintes
 * falharem. Isso é de propósito: numeração de documento fiscal é sequencial e não se recicla. Um número
 * queimado vira um buraco que se explica; um número reaproveitado vira duas notas com a mesma identidade.
 *
 * E a nota nasce com o aviso do leiaute não validado colado nela, não só na tela — para que daqui a um
 * ano ainda se saiba quais notas foram emitidas antes de alguém ter conferido o leiaute com a SEFAZ.
 */

const AVISO_LEIAUTE = 'Leiaute NÃO VALIDADO contra a SEFAZ: esta nota foi montada a partir do manual, '
  + 'mas nenhuma nota desta organização foi autorizada ainda. Confirme em homologação antes de emitir em produção.';

/** O tipo de assinante, pelo que o cadastro já sabe. 3 é residencial/pessoa física, 1 é comercial. */
const tpAssinanteDe = (assinante) => (assinante.tipo === 'pj' ? 1 : 3);

/**
 * Indicador de inscrição estadual do destinatário.
 * Pessoa física é não contribuinte (9). Pessoa jurídica com inscrição é contribuinte (1); sem
 * inscrição informada, o sistema declara "não contribuinte" em vez de supor isenção.
 */
const indIEDestDe = (assinante) => {
  if (assinante.tipo !== 'pj') return 9;
  return x.digitos(assinante.identidade) ? 1 : 9;
};

/** Reserva o próximo número da série. Nunca volta atrás. */
function reservarNumero(db, org) {
  return transacao(db, () => {
    const cfg = n.config(db, org);
    db.prepare('UPDATE fiscal_config SET proximo_numero = proximo_numero + 1, atualizado_em = ? WHERE organizacao_id = ?')
      .run(agora(), org);
    return { serie: cfg.serie, numero: cfg.proximo_numero };
  });
}

/** Carrega a fatura com tudo o que a nota precisa saber dela. */
function carregar(db, org, faturaId) {
  const fatura = db.prepare('SELECT * FROM faturas WHERE id = ? AND organizacao_id = ?').get(faturaId, org);
  if (!fatura) throw new ErroNegocio('Fatura não encontrada.', 404);
  if (fatura.situacao === 'cancelada') throw new ErroNegocio('Esta fatura foi cancelada: não há o que declarar.', 422);

  const assinante = db.prepare('SELECT * FROM assinantes WHERE id = ?').get(fatura.assinante_id);
  const contrato = fatura.contrato_id ? db.prepare('SELECT * FROM contratos WHERE id = ?').get(fatura.contrato_id) : null;
  const itens = db.prepare('SELECT * FROM fatura_itens WHERE fatura_id = ? ORDER BY id').all(fatura.id);
  if (!itens.length) throw new ErroNegocio('Esta fatura não tem itens: não há o que declarar.', 422);

  const jaTem = db.prepare(`SELECT id, chave, situacao FROM nfcom WHERE fatura_id = ? AND organizacao_id = ?
    AND situacao NOT IN ('rejeitada','cancelada') ORDER BY id DESC LIMIT 1`).get(fatura.id, org);
  if (jaTem) {
    throw new ErroNegocio(`Esta fatura já tem a nota ${jaTem.chave} (${jaTem.situacao}). Cancele a nota antes de emitir outra.`, 409);
  }
  return { fatura, assinante, contrato, itens };
}

/**
 * Monta a nota sem gravar nada. É o que a tela usa para mostrar a prévia: dá para ver o XML, os
 * tributos e os totais ANTES de queimar um número de nota fiscal.
 */
function previa(db, org, faturaId, { contingencia = null } = {}) {
  const cfg = n.config(db, org);
  const organizacao = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(org);
  const p = n.pendencias(db, org, { certificadoOk: Boolean(certificado.ativoDe(db, org)) });
  n.exigirPronto(p);

  const { fatura, assinante, contrato, itens } = carregar(db, org, faturaId);
  const hoje = dataLocal(organizacao.fuso ?? 'America/Sao_Paulo');
  const ano = Number(hoje.slice(0, 4));
  const rtc = t.aliquotasRTC(ano);

  const ufDestino = contrato?.uf ?? assinante.uf;
  const montados = n.montarItens(itens, n.regras(db, org), { ufEmitente: organizacao.uf, ufDestino, ano });
  const totais = n.somar(montados);
  if (totais.total <= 0) {
    throw new ErroNegocio('O total da nota ficou zero ou negativo depois das deduções: não há o que declarar.', 422);
  }

  /*
   * Linha digitável do boleto, quando já houver um emitido para esta fatura. Vai no codBarras do grupo
   * da fatura, e é o que permite ao DANFE-Com servir de conta a pagar. Sem boleto, o campo some.
   */
  const cobranca = db.prepare(`SELECT linha_digitavel FROM cobrancas WHERE fatura_id = ? AND organizacao_id = ?
    AND linha_digitavel IS NOT NULL ORDER BY id DESC LIMIT 1`).get(fatura.id, org);

  return {
    cfg, org: organizacao, assinante, contrato, fatura, itens: montados, totais, rtc, ano,
    linhaDigitavel: cobranca?.linha_digitavel ?? null,
    indIEDest: indIEDestDe(assinante),
    tpAssinante: tpAssinanteDe(assinante),
    codigoMunicipioDest: contrato?.codigo_municipio ?? assinante.codigo_municipio,
    contingencia,
    pendencias: p,
  };
}

/**
 * Emite: monta, reserva o número, assina e grava.
 *
 * A assinatura acontece FORA da transação de gravação, mas depois da reserva do número: a chave de acesso
 * contém o número, então não há como assinar antes de saber qual é.
 */
function emitir(db, org, faturaId, { usuarioId = null, contingencia = null } = {}) {
  const base = previa(db, org, faturaId, { contingencia });
  const { cfg, org: organizacao, fatura } = base;

  if (!base.codigoMunicipioDest) {
    throw new ErroNegocio(`Falta o código IBGE do município no endereço de ${base.assinante.nome}. `
      + 'A nota fiscal exige esse código para o destinatário.', 422);
  }

  const { serie, numero } = reservarNumero(db, org);
  const emitidaEm = agora();
  const tpEmis = contingencia ? 2 : 1;
  const k = chaveAcesso.montar({
    cUF: t.CUF[String(organizacao.uf).toUpperCase()],
    ano: Number(emitidaEm.slice(0, 4)),
    mes: Number(emitidaEm.slice(5, 7)),
    cnpj: organizacao.documento,
    serie,
    numero,
    tpEmis,
    nSiteAutoriz: cfg.site_autorizador,
  });

  const fuso = -3;
  const ide = {
    serie, numero, chave: k.chave, cNF: k.cNF, cDV: k.cDV,
    dhEmi: x.dataHora(emitidaEm, fuso), tpEmis, finNFCom: 0,
    dhCont: contingencia ? x.dataHora(emitidaEm, fuso) : null,
    xJust: contingencia?.justificativa ?? null,
  };

  const { infNFCom, canonico } = n.montarXml({ ...base, ide });

  let assinado;
  try {
    const { chave: privada, certificadoDer } = certificado.paraAssinar(db, org);
    assinado = assinaturaXml.assinar({ canonicoAssinado: canonico, id: `NFCom${k.chave}`, chave: privada, certificadoDer });
  } catch (err) {
    if (err instanceof ErroNegocio) throw err;
    throw new ErroNegocio(`Não foi possível assinar a nota: ${err.message}`, 422);
  }

  // Conferência antes de gravar: se o que foi assinado não bate com o que vai no documento, para aqui.
  const confere = assinaturaXml.conferir({ xmlAssinado: assinado, canonicoAssinado: canonico });
  if (!confere.ok) throw new ErroNegocio(`A assinatura não fechou: ${confere.motivo}`, 500);

  const xml = n.documento(infNFCom, n.qrCode(cfg, k.chave), assinado);
  const aviso = cfg.layout_validado ? null : AVISO_LEIAUTE;

  return transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO nfcom (organizacao_id, fatura_id, assinante_id, contrato_id, chave, serie, numero,
      c_nf, c_dv, ambiente, tp_emis, fin_nfcom, competencia, vencimento, emitida_em, situacao, valor_total_centavos,
      valor_icms_centavos, xml, contingencia_em, contingencia_justificativa, aviso, criado_por, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(org, fatura.id, base.assinante.id, base.contrato?.id ?? null, k.chave, serie, numero,
        k.cNF, k.cDV, cfg.ambiente, tpEmis, fatura.competencia, fatura.vencimento, emitidaEm,
        contingencia ? 'contingencia' : 'assinada', base.totais.total, base.totais.icms, xml,
        contingencia ? emitidaEm : null, contingencia?.justificativa ?? null, aviso, usuarioId, emitidaEm).lastInsertRowid);

    const inserirItem = db.prepare(`INSERT INTO nfcom_itens (organizacao_id, nfcom_id, n_item, descricao, origem, cclass, cfop,
      u_med, quantidade, valor_unitario_centavos, valor_centavos, deduz, cst_icms, bc_icms_centavos, p_icms, icms_centavos,
      pis_centavos, cofins_centavos, fust_centavos, funttel_centavos, ibs_centavos, cbs_centavos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const i of base.itens) {
      inserirItem.run(org, id, i.n_item, i.descricao, i.origem, i.cclass, i.cfop, i.u_med, i.quantidade,
        i.valor_unitario_centavos, i.valor_centavos, i.deduz ? 1 : 0, i.regra.cst_icms, i.bc_icms_centavos,
        i.regra.p_icms, i.icms_centavos, i.pis_centavos, i.cofins_centavos, i.fust_centavos, i.funttel_centavos,
        i.ibs_centavos, i.cbs_centavos);
    }
    return db.prepare('SELECT * FROM nfcom WHERE id = ?').get(id);
  });
}

/** A nota com os itens e os eventos, para a tela e para o DANFE. */
function completa(db, org, id) {
  const nota = db.prepare('SELECT * FROM nfcom WHERE id = ? AND organizacao_id = ?').get(id, org);
  if (!nota) throw new ErroNegocio('Nota não encontrada.', 404);
  return {
    ...nota,
    chave_formatada: chaveAcesso.formatar(nota.chave),
    itens: db.prepare('SELECT * FROM nfcom_itens WHERE nfcom_id = ? ORDER BY n_item').all(id),
    eventos: db.prepare('SELECT * FROM nfcom_eventos WHERE nfcom_id = ? ORDER BY criado_em DESC').all(id),
  };
}

module.exports = { AVISO_LEIAUTE, previa, emitir, completa, reservarNumero, tpAssinanteDe, indIEDestDe };
