'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');

/** Fotos do app do motorista. Chegam reduzidas pelo celular (JPEG de ~200 KB) e ficam no disco do servidor, por empresa. */
const MAX_FOTOS = 4;
const MAX_BYTES = 1_500_000;
const TIPOS = [
  ['image/jpeg', 'jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', 'png', (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))],
  ['image/webp', 'webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
];

function decodificar(texto) {
  const m = /^data:image\/[\w+.-]+;base64,(.+)$/s.exec(String(texto ?? ''));
  const b = Buffer.from(m ? m[1] : String(texto ?? ''), 'base64');
  const tipo = TIPOS.find(([, , ok]) => b.length > 12 && ok(b));
  if (!tipo) throw new ErroNegocio('Foto inválida: envie JPEG, PNG ou WEBP.', 422);
  if (b.length > MAX_BYTES) throw new ErroNegocio('Foto grande demais (máximo 1,5 MB).', 422);
  return { buffer: b, tipo: tipo[0], extensao: tipo[1] };
}

/** Confere as fotos antes de gravar o registro (assim um erro não deixa registro sem foto). */
function conferir(lista) {
  const fotos = [].concat(lista ?? []).filter(Boolean);
  if (fotos.length > MAX_FOTOS) throw new ErroNegocio(`No máximo ${MAX_FOTOS} fotos.`, 422);
  return fotos.map(decodificar);
}

function salvar(db, empresaId, origem, origemId, fotos) {
  if (!fotos.length) return [];
  const pasta = path.join(config.fotosDir, String(empresaId));
  fs.mkdirSync(pasta, { recursive: true });
  return fotos.map((f) => {
    const nome = `${origem}-${origemId}-${crypto.randomBytes(8).toString('hex')}.${f.extensao}`;
    fs.writeFileSync(path.join(pasta, nome), f.buffer);
    return Number(db.prepare('INSERT INTO fotos (empresa_id, origem, origem_id, arquivo, tipo, tamanho, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(empresaId, origem, origemId, path.join(String(empresaId), nome), f.tipo, f.buffer.length, agora()).lastInsertRowid);
  });
}

const ids = (db, origem, origemId) => db.prepare('SELECT id FROM fotos WHERE origem = ? AND origem_id = ? ORDER BY id').all(origem, origemId).map((f) => f.id);

/** Caminho do arquivo da foto da empresa (para enviar ao painel), ou null. */
function arquivo(db, empresaId, id) {
  const f = db.prepare('SELECT * FROM fotos WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!f) return null;
  const completo = path.resolve(config.fotosDir, f.arquivo);
  if (!completo.startsWith(path.resolve(config.fotosDir) + path.sep)) return null;
  return fs.existsSync(completo) ? { caminho: completo, tipo: f.tipo } : null;
}

module.exports = { conferir, salvar, ids, arquivo, MAX_FOTOS };
