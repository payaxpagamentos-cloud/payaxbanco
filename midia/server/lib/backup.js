'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

/**
 * Backup do banco e, opcionalmente, espelho dos arquivos das mídias.
 *
 * O banco cabe numa cópia compacta (VACUUM INTO) feita de tempos em tempos, com as N mais recentes guardadas.
 * Os arquivos das mídias são outra história: são grandes e nunca mudam depois de enviados, então em vez de
 * copiá-los a cada backup, o espelho copia só o que ainda não existe na pasta de destino — e só quando a pasta
 * está configurada (MIDIA_ESPELHO), para ninguém encher o disco sem querer.
 */
const PADRAO = /^midia-[\d-]+\.db$/;

function gerar(db, dir = config.backupDir) {
  fs.mkdirSync(dir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let nome = `midia-${carimbo}.db`;
  for (let i = 1; fs.existsSync(path.join(dir, nome)); i++) nome = `midia-${carimbo}-${i}.db`;
  const destino = path.join(dir, nome);
  db.prepare('VACUUM INTO ?').run(destino);
  limpar(dir);
  return { nome, tamanho: fs.statSync(destino).size, criado_em: new Date().toISOString() };
}

function listar(dir = config.backupDir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => PADRAO.test(n))
    .map((nome) => {
      const s = fs.statSync(path.join(dir, nome));
      return { nome, tamanho: s.size, criado_em: s.mtime.toISOString() };
    })
    .sort((a, b) => b.nome.localeCompare(a.nome));
}

function limpar(dir) {
  for (const b of listar(dir).slice(config.backupManter)) fs.rmSync(path.join(dir, b.nome), { force: true });
}

/** Caminho de um backup pelo nome (sem deixar sair da pasta). */
function caminho(nome, dir = config.backupDir) {
  if (!PADRAO.test(String(nome))) return null;
  const p = path.join(dir, nome);
  return fs.existsSync(p) ? p : null;
}

/**
 * Espelho dos arquivos das mídias: copia para a pasta configurada só os que ainda não estão lá.
 * Devolve quantos foram copiados e quanto ocupam no destino.
 */
function espelhar({ origem = config.arquivos, destino = config.espelho } = {}) {
  if (!destino) return { ligado: false, copiados: 0, total: 0, bytes: 0 };
  fs.mkdirSync(destino, { recursive: true });
  let copiados = 0;
  let total = 0;
  let bytes = 0;
  const nomes = fs.existsSync(origem) ? fs.readdirSync(origem) : [];
  for (const nome of nomes) {
    const de = path.join(origem, nome);
    const para = path.join(destino, nome);
    let tamanho = 0;
    try { tamanho = fs.statSync(de).size; } catch { continue; }
    total++;
    bytes += tamanho;
    let existe = false;
    try { existe = fs.statSync(para).size === tamanho; } catch { existe = false; }
    if (existe) continue;
    fs.copyFileSync(de, para);
    copiados++;
  }
  return { ligado: true, destino, copiados, total, bytes };
}

/** Situação do backup, para o painel e o diagnóstico. */
function situacao() {
  const copias = listar();
  const ultima = copias[0] ?? null;
  return {
    copias: copias.length,
    ultima,
    atrasado: !ultima || Date.now() - Date.parse(ultima.criado_em) > (config.backupIntervaloHoras + 2) * 3_600_000,
    intervalo_horas: config.backupIntervaloHoras,
    manter: config.backupManter,
    pasta: config.backupDir,
    espelho: config.espelho,
  };
}

module.exports = { gerar, listar, caminho, espelhar, situacao, limpar };
