'use strict';

const crypto = require('node:crypto');
const { tag, grupo } = require('./xml');

/*
 * Assinatura XML (XML Digital Signature) no formato que a SEFAZ exige para a NFCom.
 *
 * O que o manual determina (MOC NFCom, Visão Geral, 3.2.3 a 3.2.5):
 *   - formato "enveloped": a assinatura fica dentro do próprio documento;
 *   - o que se assina é a tag infNFCom, apontada pelo atributo Id ("NFCom" + a chave de 44 dígitos);
 *   - canonicalização C14N 1.0, resumo SHA-1, assinatura RSA-SHA1;
 *   - duas transformações na referência: enveloped-signature e C14N, nessa ordem;
 *   - KeyInfo com X509Data contendo SÓ o certificado; nada de SubjectName, IssuerSerial ou KeyValue.
 *
 * SHA-1 e RSA-SHA1 já não são escolhas defensáveis em 2026 — mas não são escolha deste sistema: é o que
 * o validador da SEFAZ aceita. Trocar por SHA-256 aqui produz uma nota rejeitada.
 *
 * Sobre a canonicalização: ela não é implementada aqui. O XML é GERADO já na forma canônica (ver
 * lib/fiscal/xml.js), então canonicalizar é não fazer nada. O que entra no resumo é, byte a byte, o que
 * é transmitido. Quem passar por aqui um XML vindo de outro gerador precisa canonicalizá-lo antes.
 */

const ALG = {
  c14n: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  envelopada: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  rsaSha1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
};
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';

const base64Quebrado = (buf) => buf.toString('base64');

/**
 * Monta a assinatura.
 *
 * @param canonicoAssinado  O trecho a assinar, já canônico — ou seja, com a declaração de namespace
 *                          herdada do elemento pai escrita nele mesmo. É isso que a C14N produziria.
 * @param id                O valor do atributo Id do trecho (sem a tralha). A referência vira "#id".
 * @param chave             A chave privada (KeyObject), vinda do certificado A1.
 * @param certificadoDer    O certificado do titular, em DER, para o KeyInfo.
 */
function assinar({ canonicoAssinado, id, chave, certificadoDer }) {
  const resumo = crypto.createHash('sha1').update(canonicoAssinado, 'utf8').digest();

  const referencia = grupo('Reference', [
    grupo('Transforms', [
      grupo('Transform', [], { attrs: { Algorithm: ALG.envelopada }, sempre: true }),
      grupo('Transform', [], { attrs: { Algorithm: ALG.c14n }, sempre: true }),
    ]),
    grupo('DigestMethod', [], { attrs: { Algorithm: ALG.sha1 }, sempre: true }),
    tag('DigestValue', base64Quebrado(resumo)),
  ], { attrs: { URI: `#${id}` } });

  const corpoAssinado = [
    grupo('CanonicalizationMethod', [], { attrs: { Algorithm: ALG.c14n }, sempre: true }),
    grupo('SignatureMethod', [], { attrs: { Algorithm: ALG.rsaSha1 }, sempre: true }),
    referencia,
  ].join('');

  /*
   * O SignedInfo é assinado na sua forma canônica, e nela o namespace da assinatura — que no documento
   * fica declarado no <Signature> pai — aparece no próprio <SignedInfo>. Por isso a string assinada e a
   * string gravada no documento são diferentes, e é de propósito.
   */
  const paraAssinar = `<SignedInfo xmlns="${NS_DSIG}">${corpoAssinado}</SignedInfo>`;
  const assinatura = crypto.sign('sha1', Buffer.from(paraAssinar, 'utf8'), chave);

  return grupo('Signature', [
    `<SignedInfo>${corpoAssinado}</SignedInfo>`,
    tag('SignatureValue', base64Quebrado(assinatura)),
    grupo('KeyInfo', [grupo('X509Data', [tag('X509Certificate', certificadoDer.toString('base64'))])]),
  ], { attrs: { xmlns: NS_DSIG } });
}

/**
 * Confere uma assinatura que este módulo produziu: o resumo bate com o trecho e a assinatura bate com o
 * certificado. Serve para os testes e para a conferência antes de transmitir — assinar errado e só
 * descobrir pela rejeição da SEFAZ é caro.
 */
function conferir({ xmlAssinado, canonicoAssinado }) {
  const pegar = (nome) => {
    const m = new RegExp(`<${nome}>([^<]*)</${nome}>`).exec(xmlAssinado);
    return m ? m[1] : null;
  };
  const digestValue = pegar('DigestValue');
  const signatureValue = pegar('SignatureValue');
  const certificado = pegar('X509Certificate');
  if (!digestValue || !signatureValue || !certificado) return { ok: false, motivo: 'Assinatura incompleta no XML.' };

  const resumo = crypto.createHash('sha1').update(canonicoAssinado, 'utf8').digest('base64');
  if (resumo !== digestValue) return { ok: false, motivo: 'O resumo não corresponde ao conteúdo assinado — o XML mudou depois de assinado.' };

  const m = /<SignedInfo>([\s\S]*?)<\/SignedInfo>/.exec(xmlAssinado);
  if (!m) return { ok: false, motivo: 'SignedInfo não encontrado.' };
  const paraAssinar = `<SignedInfo xmlns="${NS_DSIG}">${m[1]}</SignedInfo>`;

  const x509 = new crypto.X509Certificate(Buffer.from(certificado, 'base64'));
  const ok = crypto.verify('sha1', Buffer.from(paraAssinar, 'utf8'), x509.publicKey, Buffer.from(signatureValue, 'base64'));
  return ok ? { ok: true, titular: x509.subject } : { ok: false, motivo: 'A assinatura não confere com o certificado anexado.' };
}

module.exports = { assinar, conferir, ALG, NS_DSIG };
