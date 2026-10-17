'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

/** Cópia consistente do banco (VACUUM INTO) com data e hora no nome; mantém as N mais recentes. */
function gerar(db, dir = config.backupDir) {
  fs.mkdirSync(dir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let nome = `bpo-${carimbo}.db`;
  for (let i = 1; fs.existsSync(path.join(dir, nome)); i++) nome = `bpo-${carimbo}-${i}.db`;
  const destino = path.join(dir, nome);
  db.prepare('VACUUM INTO ?').run(destino);
  limpar(dir);
  return { nome, tamanho: fs.statSync(destino).size };
}

function listar(dir = config.backupDir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^bpo-[\d-]+\.db$/.test(n))
    .map((nome) => ({ nome, tamanho: fs.statSync(path.join(dir, nome)).size, criado_em: fs.statSync(path.join(dir, nome)).mtime.toISOString() }))
    .sort((a, b) => b.nome.localeCompare(a.nome));
}

function limpar(dir) {
  for (const b of listar(dir).slice(config.backupManter)) fs.rmSync(path.join(dir, b.nome), { force: true });
}

/** Caminho de um backup pelo nome (sem permitir sair da pasta). */
function caminho(nome, dir = config.backupDir) {
  if (!/^bpo-[\d-]+\.db$/.test(String(nome))) return null;
  const p = path.join(dir, nome);
  return fs.existsSync(p) ? p : null;
}

module.exports = { gerar, listar, caminho };
