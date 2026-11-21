'use strict';

const { transacao, agora } = require('../../db');
const { ErroNegocio } = require('../erros');
const certificado = require('../certificado');
const assinaturaXml = require('./assinatura');
const sefaz = require('./sefaz');
const t = require('./tabelas');
const n = require('./nfcom');
const x = require('./xml');

/*
 * Transmitir, consultar e cancelar.
 *
 * Regra que vale para as três: o que a SEFAZ responde é guardado inteiro, como veio, antes de qualquer
 * interpretação. O protocolo de autorização é o que prova que a nota existe perante o Fisco; perdê-lo
 * por ter guardado só o resumo que o sistema entendeu seria perder a prova.
 *
 * A situação da nota muda só pelo que a SEFAZ disse. Não há caminho no sistema para marcar uma nota como
 * autorizada à mão — nota fiscal não é um campo de banco que alguém resolve acertar.
 */

/* Códigos de situação que importam (MOC NFCom). O resto é rejeição, com o motivo que vier. */
const AUTORIZADO = '100';
const CANCELAMENTO_HOMOLOGADO = '101';
const DENEGADOS = new Set(['110', '301', '302']);
const EVENTO_OK = new Set(['135', '136']);
const EVENTO_CANCELAMENTO = '110111';

/** O certificado serve para duas coisas: identificar quem transmite e assinar o documento. */
function credenciais(db, org, { ca = null } = {}) {
  const c = certificado.paraAssinar(db, org);
  return {
    envio: { pfx: c.pfx, passphrase: c.passphrase, ...(ca ? { ca } : {}) },
    chave: c.chave,
    certificadoDer: c.certificadoDer,
  };
}

/** Pergunta à SEFAZ se o serviço está no ar. Não mexe em nota nenhuma. */
async function testar(db, org, opcoes = {}) {
  const cfg = n.config(db, org);
  const c = credenciais(db, org, opcoes);
  const r = await sefaz.statusServico(cfg, c.envio);
  return {
    ambiente: cfg.ambiente,
    autorizador: cfg.autorizador,
    url: r.url,
    c_stat: r.cStat,
    x_motivo: r.xMotivo,
    no_ar: r.cStat === '107',
  };
}

/** Qual situação a resposta da SEFAZ determina. */
function situacaoPor(cStat) {
  if (cStat === AUTORIZADO) return 'autorizada';
  if (DENEGADOS.has(cStat)) return 'denegada';
  return 'rejeitada';
}

/**
 * Transmite uma nota já assinada.
 *
 * Antes de enviar, marca a nota como "enviando". É o que impede dois cliques virarem duas transmissões
 * da mesma nota — e a SEFAZ, recebendo a segunda, responderia duplicidade de chave, que é um susto
 * desnecessário no meio do fechamento do mês.
 */
async function transmitir(db, org, notaId, { usuarioId = null, ca = null } = {}) {
  const nota = db.prepare('SELECT * FROM nfcom WHERE id = ? AND organizacao_id = ?').get(notaId, org);
  if (!nota) throw new ErroNegocio('Nota não encontrada.', 404);
  if (!nota.xml) throw new ErroNegocio('Esta nota ainda não foi montada e assinada.', 422);
  if (nota.situacao === 'autorizada') throw new ErroNegocio('Esta nota já está autorizada.', 409);
  if (nota.situacao === 'cancelada') throw new ErroNegocio('Esta nota foi cancelada.', 409);
  if (nota.situacao === 'enviando') throw new ErroNegocio('Esta nota já está sendo transmitida. Aguarde o retorno.', 409);

  const cfg = n.config(db, org);
  if (cfg.ambiente !== nota.ambiente) {
    throw new ErroNegocio(`Esta nota foi emitida em ${t.TP_AMB[nota.ambiente]} e a configuração está em `
      + `${t.TP_AMB[cfg.ambiente]}. Uma nota não muda de ambiente: emita outra.`, 422);
  }

  const c = credenciais(db, org, { ca });
  db.prepare("UPDATE nfcom SET situacao = 'enviando', versao = versao + 1 WHERE id = ?").run(nota.id);

  let r;
  try {
    r = await sefaz.chamar('recepcao', cfg, nota.xml, c.envio);
  } catch (err) {
    // Falhou antes de a SEFAZ responder: a nota volta ao estado anterior, porque nada foi decidido lá.
    db.prepare('UPDATE nfcom SET situacao = ?, versao = versao + 1 WHERE id = ?').run(nota.situacao, nota.id);
    throw err;
  }

  const situacao = situacaoPor(r.cStat);
  return transacao(db, () => {
    db.prepare(`UPDATE nfcom SET situacao = ?, protocolo = ?, c_stat = ?, x_motivo = ?, xml_protocolo = ?,
      autorizada_em = ?, versao = versao + 1 WHERE id = ?`)
      .run(situacao, r.nProt, r.cStat, r.xMotivo, r.protocolo ?? r.corpo,
        situacao === 'autorizada' ? agora() : null, nota.id);
    void usuarioId;
    return { ...db.prepare('SELECT * FROM nfcom WHERE id = ?').get(nota.id), c_stat: r.cStat, x_motivo: r.xMotivo };
  });
}

/** Pergunta à SEFAZ o que ela sabe sobre a nota. Serve quando a transmissão caiu no meio. */
async function consultar(db, org, notaId, { ca = null } = {}) {
  const nota = db.prepare('SELECT * FROM nfcom WHERE id = ? AND organizacao_id = ?').get(notaId, org);
  if (!nota) throw new ErroNegocio('Nota não encontrada.', 404);
  const cfg = n.config(db, org);
  const c = credenciais(db, org, { ca });
  const r = await sefaz.consultarChave(cfg, nota.chave, c.envio);

  /*
   * A consulta é a autoridade: se a SEFAZ diz que está autorizada, está — mesmo que a transmissão tenha
   * parecido falhar. É assim que uma nota "presa em enviando" se resolve sem emitir outra.
   */
  if (r.cStat === AUTORIZADO && nota.situacao !== 'autorizada') {
    db.prepare(`UPDATE nfcom SET situacao = 'autorizada', protocolo = ?, c_stat = ?, x_motivo = ?, xml_protocolo = ?,
      autorizada_em = ?, versao = versao + 1 WHERE id = ?`)
      .run(r.nProt, r.cStat, r.xMotivo, r.protocolo ?? r.corpo, agora(), nota.id);
  } else if (r.cStat === CANCELAMENTO_HOMOLOGADO && nota.situacao !== 'cancelada') {
    db.prepare(`UPDATE nfcom SET situacao = 'cancelada', c_stat = ?, x_motivo = ?, versao = versao + 1 WHERE id = ?`)
      .run(r.cStat, r.xMotivo, nota.id);
  }
  return { c_stat: r.cStat, x_motivo: r.xMotivo, protocolo: r.nProt, nota: db.prepare('SELECT * FROM nfcom WHERE id = ?').get(nota.id) };
}

/* ------------------------------------------------------------------ *
 * Cancelamento (evento 110111)
 * ------------------------------------------------------------------ */

/**
 * Monta o XML do evento de cancelamento.
 *
 * O Id tem 55 caracteres: "ID" + o código do evento + a chave + a sequência em três dígitos. É esse Id
 * que a assinatura aponta, do mesmo jeito que na nota.
 */
function montarEventoCancelamento({ cfg, org, nota, justificativa, sequencia = 1, dhEvento }) {
  const seq = String(sequencia).padStart(3, '0');
  const id = `ID${EVENTO_CANCELAMENTO}${nota.chave}${seq}`;
  const interior = [
    x.tag('cOrgao', t.CUF[String(org.uf).toUpperCase()]),
    x.tag('tpAmb', cfg.ambiente),
    x.tag('CNPJ', x.digitos(org.documento, 14)),
    x.tag('chNFCom', nota.chave),
    x.tag('dhEvento', dhEvento),
    x.tag('tpEvento', EVENTO_CANCELAMENTO),
    x.tag('nSeqEvento', sequencia),
    x.grupo('detEvento', [
      x.grupo('evCancNFCom', [
        x.tag('descEvento', 'Cancelamento'),
        x.tag('nProt', nota.protocolo),
        x.tag('xJust', x.texto(justificativa, 255)),
      ]),
    ], { attrs: { versaoEvento: t.VERSAO_LEIAUTE } }),
  ].join('');
  const attrs = { Id: id };
  return {
    id,
    infEvento: x.grupo('infEvento', [interior], { attrs }),
    canonico: x.grupo('infEvento', [interior], { attrs: { xmlns: t.NAMESPACE, ...attrs } }),
  };
}

/**
 * Cancela a nota na SEFAZ.
 *
 * Só nota AUTORIZADA se cancela: o que não foi autorizado não existe para o Fisco e não precisa de
 * evento. E o cancelamento não apaga nada — vira um evento com protocolo próprio, ao lado da nota.
 */
async function cancelar(db, org, notaId, { justificativa, usuarioId = null, ca = null }) {
  const nota = db.prepare('SELECT * FROM nfcom WHERE id = ? AND organizacao_id = ?').get(notaId, org);
  if (!nota) throw new ErroNegocio('Nota não encontrada.', 404);
  if (nota.situacao === 'cancelada') throw new ErroNegocio('Esta nota já está cancelada.', 409);
  if (nota.situacao !== 'autorizada') {
    throw new ErroNegocio('Só se cancela nota autorizada. Esta está como "' + nota.situacao + '": o que não foi '
      + 'autorizado não existe para o Fisco e não precisa de cancelamento.', 422);
  }
  if (!nota.protocolo) throw new ErroNegocio('Esta nota não tem protocolo de autorização guardado: sem ele a SEFAZ não aceita o cancelamento.', 422);
  const texto = x.texto(justificativa, 255);
  if (!texto || texto.length < 15) throw new ErroNegocio('A justificativa do cancelamento precisa de pelo menos 15 caracteres.', 422);

  const cfg = n.config(db, org);
  const organizacao = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(org);
  const c = credenciais(db, org, { ca });
  const dhEvento = x.dataHora(agora(), -3);

  const ev = montarEventoCancelamento({ cfg, org: organizacao, nota, justificativa: texto, dhEvento });
  const sig = assinaturaXml.assinar({ canonicoAssinado: ev.canonico, id: ev.id, chave: c.chave, certificadoDer: c.certificadoDer });
  const xmlEvento = x.documento(x.grupo('eventoNFCom', [ev.infEvento, sig], { attrs: { xmlns: t.NAMESPACE, versao: t.VERSAO_LEIAUTE } }));

  const eventoId = Number(db.prepare(`INSERT INTO nfcom_eventos (organizacao_id, nfcom_id, chave, tipo, descricao, sequencia,
    justificativa, xml, situacao, criado_por, criado_em) VALUES (?, ?, ?, ?, 'Cancelamento', 1, ?, ?, 'pendente', ?, ?)`)
    .run(org, nota.id, nota.chave, EVENTO_CANCELAMENTO, texto, xmlEvento, usuarioId, agora()).lastInsertRowid);

  let r;
  try {
    r = await sefaz.chamar('evento', cfg, xmlEvento, c.envio);
  } catch (err) {
    db.prepare("UPDATE nfcom_eventos SET situacao = 'rejeitado', x_motivo = ? WHERE id = ?").run(String(err.message).slice(0, 500), eventoId);
    throw err;
  }

  const aceito = EVENTO_OK.has(r.cStat) || r.cStat === CANCELAMENTO_HOMOLOGADO;
  return transacao(db, () => {
    db.prepare(`UPDATE nfcom_eventos SET situacao = ?, protocolo = ?, c_stat = ?, x_motivo = ?, xml_retorno = ?,
      registrado_em = ? WHERE id = ?`)
      .run(aceito ? 'registrado' : 'rejeitado', r.nProt, r.cStat, r.xMotivo, r.protocolo ?? r.corpo,
        aceito ? agora() : null, eventoId);
    if (aceito) {
      db.prepare("UPDATE nfcom SET situacao = 'cancelada', versao = versao + 1 WHERE id = ?").run(nota.id);
    }
    return {
      cancelada: aceito,
      c_stat: r.cStat,
      x_motivo: r.xMotivo,
      evento: db.prepare('SELECT * FROM nfcom_eventos WHERE id = ?').get(eventoId),
      nota: db.prepare('SELECT * FROM nfcom WHERE id = ?').get(nota.id),
    };
  });
}

module.exports = {
  AUTORIZADO, CANCELAMENTO_HOMOLOGADO, DENEGADOS, EVENTO_OK, EVENTO_CANCELAMENTO,
  testar, transmitir, consultar, cancelar, montarEventoCancelamento, situacaoPor,
};
