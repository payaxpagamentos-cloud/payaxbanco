'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const crypto = require('node:crypto');
const os = require('node:os');
const config = require('../config');

/**
 * Licença de uso presa ao servidor (anti-cópia). A licença é um texto assinado com uma chave privada que só o fornecedor tem;
 * ela carrega o "destino" (domínio ou nome do host) e, se quiser, uma validade. No arranque, o sistema confere a assinatura
 * (com a chave pública embutida) e que o destino bate com este servidor. Copiar a pasta para outra máquina não funciona: a
 * licença não assina o novo host, e sem a chave privada do fornecedor ninguém gera outra.
 *
 * Em produção (NODE_ENV=production), sem licença válida o sistema não sobe. Em desenvolvimento, apenas avisa.
 * A licença vai em RASTREADOR_LICENCA (uma linha) ou no arquivo licenca.key ao lado do .env.
 *
 * O fornecedor gera licenças com: node scripts/licenca.js <destino> [dias]
 */

// Chave pública do fornecedor (Ed25519, formato SPKI base64). Troque pela sua gerada em scripts/licenca.js (gerar-par).
// Com a chave pública aqui, o sistema confere licenças; só quem tem a chave privada emite novas.
const CHAVE_PUBLICA = process.env.RASTREADOR_LICENCA_PUBKEY
  || 'MCowBQYDK2VwAyEARfX1 r 0PLACEHOLDER0PLACEHOLDER0PLACEHOLDER0K='.replace(/ r /g, '');

/** Identificadores possíveis deste servidor: nome do host e o domínio público configurado (RASTREADOR_URL_PUBLICA). */
function destinosDoServidor() {
  const lista = new Set();
  const host = os.hostname();
  if (host) { lista.add(host.toLowerCase()); lista.add(host.toLowerCase().split('.')[0]); }
  if (config.urlPublica) {
    try { lista.add(new URL(config.urlPublica).hostname.toLowerCase()); } catch { /* url inválida: ignora */ }
  }
  return lista;
}

/** Lê a licença: variável RASTREADOR_LICENCA ou o arquivo licenca.key ao lado do código. */
function lerTexto() {
  if (process.env.RASTREADOR_LICENCA) return process.env.RASTREADOR_LICENCA.trim();
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    return fs.readFileSync(path.join(__dirname, '..', '..', 'licenca.key'), 'utf8').trim();
  } catch { return ''; }
}

/** Decodifica e confere a assinatura e o destino. Devolve { valida, motivo, destino, expira }. */
function verificar(texto = lerTexto(), destinos = destinosDoServidor()) {
  if (!texto) return { valida: false, motivo: 'nenhuma licença encontrada (RASTREADOR_LICENCA ou licenca.key)' };
  const partes = texto.split('.');
  if (partes.length !== 2) return { valida: false, motivo: 'formato de licença inválido' };
  let dados;
  try {
    dados = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
    const chave = crypto.createPublicKey({ key: Buffer.from(CHAVE_PUBLICA, 'base64'), format: 'der', type: 'spki' });
    const ok = crypto.verify(null, Buffer.from(partes[0]), chave, Buffer.from(partes[1], 'base64url'));
    if (!ok) return { valida: false, motivo: 'assinatura da licença inválida' };
  } catch (err) {
    return { valida: false, motivo: `licença ilegível (${err.message})` };
  }
  const destino = String(dados.destino || '').toLowerCase();
  if (destino && destino !== '*' && !destinos.has(destino)) {
    return { valida: false, motivo: `licença emitida para "${destino}", mas este servidor é "${[...destinos].join(', ') || 'desconhecido'}"`, destino };
  }
  if (dados.expira && Date.now() > Date.parse(dados.expira)) {
    return { valida: false, motivo: `licença vencida em ${dados.expira}`, destino, expira: dados.expira };
  }
  return { valida: true, destino: destino || '*', cliente: dados.cliente || null, expira: dados.expira || null };
}

/** Chamado no arranque. Em produção, encerra o processo se a licença não for válida. */
function exigir() {
  // Sem chave pública configurada (instalação ainda não licenciada), a verificação fica desligada para não travar o uso.
  if (/PLACEHOLDER/.test(CHAVE_PUBLICA)) {
    if (config.producao) console.warn('[Rastreador] Licença não configurada (RASTREADOR_LICENCA_PUBKEY). A proteção de cópia está desligada.');
    return { valida: true, desligada: true };
  }
  const r = verificar();
  if (r.valida) {
    console.log(`[Rastreador] Licença válida${r.cliente ? ` · ${r.cliente}` : ''}${r.expira ? ` · até ${r.expira.slice(0, 10)}` : ''}.`);
    return r;
  }
  if (config.producao) {
    console.error(`[Rastreador] Licença inválida: ${r.motivo}.`);
    console.error('[Rastreador] Este sistema é licenciado e não roda sem uma licença válida para este servidor. Fale com o fornecedor.');
    process.exit(1);
  }
  console.warn(`[Rastreador] Licença inválida (${r.motivo}). Em produção, o sistema não iniciaria.`);
  return r;
}

module.exports = { verificar, exigir, destinosDoServidor };
