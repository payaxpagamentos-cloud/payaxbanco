'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { ErroNegocio } = require('./erros');

/** Cifra um texto (credencial de integração) com AES-256-GCM. Formato: v1.<iv>.<tag>.<dados> em base64url. */
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.chaveCredenciais, iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), dados.toString('base64url')].join('.');
}

function decifrar(pacote) {
  const [v, iv, tag, dados] = String(pacote ?? '').split('.');
  if (v !== 'v1') throw new Error('Credencial cifrada em formato desconhecido.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', config.chaveCredenciais, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(dados, 'base64url')), d.final()]).toString('utf8');
  } catch {
    /*
     * O GCM só falha aqui por dois motivos: a chave mudou ou o dado foi adulterado. A mensagem do Node
     * ("Unsupported state or unable to authenticate data") não ajuda ninguém a resolver, e quem troca
     * NETWORK_SECRET sem migrar as credenciais recebe isso em TODAS as integrações de uma vez.
     */
    throw new ErroNegocio('Não foi possível decifrar esta credencial: a chave do sistema (NETWORK_SECRET) mudou depois que ela foi salva, '
      + 'ou o registro foi alterado fora do sistema. Cadastre a credencial de novo.', 422);
  }
}

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const assinar = (dados) => crypto.createHmac('sha256', config.secret).update(dados).digest('base64url');

module.exports = { cifrar, decifrar, sha256, assinar };
