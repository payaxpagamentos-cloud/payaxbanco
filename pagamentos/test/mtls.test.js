'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pedir } = require('../server/lib/bradesco');

/** Gera, com o openssl, uma autoridade, o certificado do servidor e o do cliente (a PAY AX). */
function certificados() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mtls-'));
  const o = (...a) => execFileSync('openssl', a, { cwd: d, stdio: 'ignore' });
  o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=ca-teste');
  for (const n of ['servidor', 'cliente']) {
    o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.csr`, '-subj', `/CN=${n === 'servidor' ? 'localhost' : 'payax-teste'}`);
    o('x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${n}.pem`, '-days', '1');
  }
  const ler = (f) => fs.readFileSync(path.join(d, f), 'utf8');
  return { ca: ler('ca.pem'), servidor: { cert: ler('servidor.pem'), key: ler('servidor.key') }, cliente: { cert: ler('cliente.pem'), key: ler('cliente.key') } };
}

let temOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { temOpenssl = false; }

test('o certificado da PAY AX chega ao banco (mTLS)', { skip: !temOpenssl && 'sem openssl' }, async () => {
  const c = certificados();
  const srv = https.createServer({ ...c.servidor, ca: c.ca, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const cert = req.socket.getPeerCertificate();
    res.end(JSON.stringify({ autorizado: req.socket.authorized, cn: cert?.subject?.CN ?? null }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `https://localhost:${srv.address().port}/`;
    const com = await pedir(url, { agent: new https.Agent({ ...c.cliente, ca: c.ca }) });
    assert.deepEqual(await com.json(), { autorizado: true, cn: 'payax-teste' }, 'com o agente, o certificado é apresentado');
    const sem = await pedir(url, { agent: new https.Agent({ ca: c.ca }) });
    assert.deepEqual(await sem.json(), { autorizado: false, cn: null }, 'sem o certificado, o servidor percebe');
  } finally {
    srv.close();
  }
});

test('tempo esgotado vira erro TimeoutError (o repasse não pode presumir falha)', async () => {
  const http = require('node:http');
  const srv = http.createServer(() => { /* nunca responde */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(pedir(`http://127.0.0.1:${srv.address().port}/`, { timeoutMs: 150 }), { name: 'TimeoutError' });
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});
