'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Gera certificados A1 de mentira para os testes, com openssl.
 *
 * São certificados de verdade (chave, assinatura, validade): o que é falso é a autoridade que os emitiu.
 * O "legado: true" produz o formato antigo (RC2-40), que é como muitos A1 brasileiros ainda vêm e que o
 * Node recusa por padrão — é o caso que o sistema precisa explicar, e não dá para testá-lo sem produzi-lo.
 *
 * Para o caso "certificado vencido" não se gera um certificado no passado (o OpenSSL 3.0 não tem a opção):
 * gera-se um válido e passa-se uma data de referência futura para quem o avalia. O caminho de código
 * exercitado é o mesmo.
 */
function criarCertificado({ nome = 'PROVEDOR TESTE LTDA', cnpj = '11222333000181', senha = 'senha-do-certificado', dias = 365, legado = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  const chave = path.join(dir, 'k.pem');
  const pem = path.join(dir, 'c.pem');
  const pfx = path.join(dir, 'c.pfx');
  const assunto = `/C=BR/O=ICP-Brasil/OU=AC Teste/CN=${nome}${cnpj ? `:${cnpj}` : ''}`;
  const silencioso = { stdio: ['ignore', 'ignore', 'ignore'] };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', chave, '-out', pem,
    '-days', String(Math.max(1, dias)), '-nodes', '-subj', assunto], silencioso);
  execFileSync('openssl', ['pkcs12', '-export', '-out', pfx, '-inkey', chave, '-in', pem, '-passout', `pass:${senha}`,
    ...(legado ? ['-legacy'] : ['-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'sha256'])], silencioso);
  const bytes = fs.readFileSync(pfx);
  fs.rmSync(dir, { recursive: true, force: true });
  return { bytes, base64: bytes.toString('base64'), senha, nome, cnpj };
}

const temOpenssl = () => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } };

module.exports = { criarCertificado, temOpenssl };
