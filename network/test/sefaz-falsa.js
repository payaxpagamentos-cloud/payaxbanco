'use strict';

const https = require('node:https');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * SEFAZ de mentira: um servidor HTTPS que fala o mesmo protocolo.
 *
 * Por que isto existe: a SEFAZ de verdade exige TLS com autenticação mútua, cadeia ICP-Brasil e
 * credenciamento do CNPJ — nada disso existe numa máquina de testes, e nenhuma dessas três coisas é o
 * que o código deste sistema precisa provar. O que precisa ser provado é o que é nosso: o envelope SOAP
 * sai certo, o XML vai compactado onde deve ir, o retorno é lido corretamente, a falha SOAP vira uma
 * mensagem que ensina, e a situação da nota muda só pelo que a SEFAZ disse.
 *
 * Este servidor PEDE o certificado do cliente e registra qual veio, mas não o exige — assim o teste
 * também confirma que o sistema está mesmo mandando o A1 como identidade de quem transmite.
 */

/** Certificado de servidor para o próprio teste (a máquina do teste é a "SEFAZ"). */
function certificadoDeServidor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sefaz-'));
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2',
    '-nodes', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
  const par = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return par;
}

const envelope = (corpo) => '<?xml version="1.0" encoding="UTF-8"?>'
  + '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
  + `<nfcomResultMsg xmlns="http://www.portalfiscal.inf.br/nfcom/wsdl/NFComRecepcao">${corpo}</nfcomResultMsg>`
  + '</soap:Body></soap:Envelope>';

/**
 * Sobe a SEFAZ de mentira. `responder(pedido)` devolve o corpo da resposta, ou um objeto
 * { status, corpo } para controlar o código HTTP. `pedido` traz o XML já descompactado.
 */
async function iniciar(responder) {
  const { key, cert } = certificadoDeServidor();
  const recebidos = [];
  const servidor = https.createServer({ key, cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const pedacos = [];
    req.on('data', (d) => pedacos.push(d));
    req.on('end', () => {
      const bruto = Buffer.concat(pedacos).toString('utf8');
      const m = /<nfcomDadosMsg[^>]*>([\s\S]*?)<\/nfcomDadosMsg>/.exec(bruto);
      let conteudo = m ? m[1] : bruto;
      let comprimido = false;
      // Se não parece XML, veio em GZip+Base64 — que é como a recepção manda a nota.
      if (!conteudo.trimStart().startsWith('<')) {
        try { conteudo = zlib.gunzipSync(Buffer.from(conteudo, 'base64')).toString('utf8'); comprimido = true; } catch { /* deixa cru */ }
      }
      const pedido = {
        caminho: req.url,
        contentType: req.headers['content-type'],
        envelope: bruto,
        xml: conteudo,
        comprimido,
        certificadoCliente: req.socket.getPeerCertificate?.() ?? null,
      };
      recebidos.push(pedido);
      /*
       * `responder` devolve uma string (o corpo do retorno, que aqui é embrulhado no envelope), ou
       * { status, bruto } quando o teste precisa controlar o HTTP e mandar o corpo exatamente como está
       * — é assim que se simula uma falha SOAP.
       */
      const r = responder(pedido) ?? '';
      if (typeof r === 'string') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
        res.end(envelope(r));
      } else {
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
        res.end(r.bruto ?? '');
      }
    });
  });
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const porta = servidor.address().port;
  return {
    recebidos,
    base: `https://127.0.0.1:${porta}`,
    ca: cert,
    url: (servico) => `https://127.0.0.1:${porta}/WS/${servico}`,
    fechar: () => new Promise((ok) => servidor.close(ok)),
  };
}

/** Respostas prontas, no formato que a SEFAZ usa. */
const RESPOSTAS = {
  autorizada: (chave, protocolo = '141260000012345') => '<retNFCom versao="1.00">'
    + `<tpAmb>2</tpAmb><cStat>100</cStat><xMotivo>Autorizado o uso da NFCom</xMotivo><chNFCom>${chave}</chNFCom>`
    + `<protNFCom versao="1.00"><infProt><chNFCom>${chave}</chNFCom><dhRecbto>2026-11-21T12:00:00-03:00</dhRecbto>`
    + `<nProt>${protocolo}</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NFCom</xMotivo></infProt></protNFCom>`
    + '</retNFCom>',
  rejeitada: (cStat = '539', motivo = 'Rejeicao: Duplicidade de NFCom') =>
    `<retNFCom versao="1.00"><tpAmb>2</tpAmb><cStat>${cStat}</cStat><xMotivo>${motivo}</xMotivo></retNFCom>`,
  denegada: () => '<retNFCom versao="1.00"><tpAmb>2</tpAmb><cStat>302</cStat><xMotivo>Rejeicao: Irregularidade fiscal do destinatario</xMotivo></retNFCom>',
  statusNoAr: () => '<retConsStatServNFCom versao="1.00"><tpAmb>2</tpAmb><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServNFCom>',
  eventoRegistrado: (chave, protocolo = '141260000099999') => '<retEventoNFCom versao="1.00"><infEvento>'
    + `<tpAmb>2</tpAmb><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NFCom</xMotivo><chNFCom>${chave}</chNFCom>`
    + `<nProt>${protocolo}</nProt></infEvento></retEventoNFCom>`,
  eventoRejeitado: () => '<retEventoNFCom versao="1.00"><infEvento><tpAmb>2</tpAmb><cStat>573</cStat>'
    + '<xMotivo>Rejeicao: Duplicidade de evento</xMotivo></infEvento></retEventoNFCom>',
};

/** Falha SOAP crua, como um servidor devolve quando não reconhece o elemento enviado. */
const falhaSoap = (texto) => ({
  status: 500,
  bruto: '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><soap:Fault>'
    + `<soap:Code><soap:Value>soap:Sender</soap:Value></soap:Code><soap:Reason><soap:Text>${texto}</soap:Text></soap:Reason>`
    + '</soap:Fault></soap:Body></soap:Envelope>',
});

module.exports = { iniciar, RESPOSTAS, falhaSoap, envelope };
