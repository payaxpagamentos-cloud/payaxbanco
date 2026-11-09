#!/usr/bin/env node
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
'use strict';

/**
 * Gerador de licenças do Rastreador (uso do FORNECEDOR, não do cliente).
 *
 *   node scripts/licenca.js gerar-par
 *       Cria o par de chaves (uma vez). Guarde a PRIVADA em segredo (nunca entra no pacote do cliente).
 *       Copie a PÚBLICA para server/lib/licenca.js (CHAVE_PUBLICA) ou para RASTREADOR_LICENCA_PUBKEY.
 *
 *   node scripts/licenca.js emitir <destino> [dias] ["Nome do cliente"]
 *       Emite uma licença para um servidor. <destino> é o domínio ou o nome do host do servidor do cliente
 *       (ex.: rastreador.cliente.com ou srv2045859). Use "*" para liberar em qualquer servidor.
 *       Precisa da chave privada em RASTREADOR_LICENCA_PRIVKEY ou no arquivo licenca-privada.key.
 *
 * O cliente recebe só a linha da licença (põe em RASTREADOR_LICENCA no .env ou num arquivo licenca.key).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [cmd, destino, dias, cliente] = process.argv.slice(2);

if (cmd === 'gerar-par') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  fs.writeFileSync(path.join(__dirname, '..', 'licenca-privada.key'), priv);
  console.log('Par gerado. A PRIVADA foi salva em licenca-privada.key (NÃO distribua, NÃO comite).');
  console.log('\nCole esta CHAVE PÚBLICA em server/lib/licenca.js (const CHAVE_PUBLICA):\n');
  console.log(pub);
  process.exit(0);
}

if (cmd === 'emitir') {
  if (!destino) { console.error('Uso: node scripts/licenca.js emitir <destino> [dias] ["Cliente"]'); process.exit(1); }
  let priv = process.env.RASTREADOR_LICENCA_PRIVKEY;
  try { priv = priv || fs.readFileSync(path.join(__dirname, '..', 'licenca-privada.key'), 'utf8').trim(); } catch { /* usa a variável */ }
  if (!priv) { console.error('Chave privada ausente (licenca-privada.key ou RASTREADOR_LICENCA_PRIVKEY). Rode "gerar-par" primeiro.'); process.exit(1); }
  const chave = crypto.createPrivateKey({ key: Buffer.from(priv, 'base64'), format: 'der', type: 'pkcs8' });
  const dados = { destino: String(destino).toLowerCase(), emitida: new Date().toISOString().slice(0, 10) };
  if (dias && Number(dias) > 0) dados.expira = new Date(Date.now() + Number(dias) * 86_400_000).toISOString();
  if (cliente) dados.cliente = cliente;
  const corpo = Buffer.from(JSON.stringify(dados)).toString('base64url');
  const assinatura = crypto.sign(null, Buffer.from(corpo), chave).toString('base64url');
  console.log(`\nLicença para "${dados.destino}"${dados.expira ? ` (até ${dados.expira.slice(0, 10)})` : ' (sem validade)'}:\n`);
  console.log(`${corpo}.${assinatura}`);
  console.log('\nO cliente põe essa linha em RASTREADOR_LICENCA no .env (ou num arquivo licenca.key na pasta do sistema).');
  process.exit(0);
}

console.error('Comandos: gerar-par | emitir <destino> [dias] ["Cliente"]');
process.exit(1);
