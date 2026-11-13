'use strict';

/**
 * Cópia de segurança do mercadinho: o banco inteiro, as fotos dos produtos e os vídeos e imagens da vitrine.
 *
 *   node --env-file=.env scripts/backup.js                  (grava em ./backups)
 *   node --env-file=.env scripts/backup.js /mnt/pendrive    (grava onde você mandar)
 *   node --env-file=.env scripts/backup.js --verificar <pasta>   (confere uma cópia já feita)
 *
 * O banco é copiado com VACUUM INTO, e não com "cp": assim a cópia sai consistente mesmo com o
 * sistema aberto e vendendo (copiar o arquivo na mão pode pegar o banco no meio de uma gravação).
 *
 * Para rodar todo dia de madrugada, no crontab do servidor:
 *   15 3 * * * cd /caminho/do/mercadinho && node --env-file=.env scripts/backup.js >> backups/backup.log 2>&1
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../server/config');

const argumentos = process.argv.slice(2);
const verificar = argumentos.includes('--verificar');
const destinoPedido = argumentos.find((a) => !a.startsWith('--'));
const DIAS_PARA_GUARDAR = Number(process.env.MERCADO_BACKUP_DIAS || 30);

const tamanho = (arquivo) => `${(fs.statSync(arquivo).size / 1024 / 1024).toFixed(1)} MB`;

/** Confere se a cópia abre e tem as tabelas e os números esperados. */
function conferir(arquivoDb) {
  const db = new DatabaseSync(arquivoDb, { readOnly: true });
  const integridade = db.prepare('PRAGMA integrity_check').get();
  const contar = (tabela) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n;
  const resultado = {
    integridade: Object.values(integridade)[0],
    produtos: contar('produtos'),
    vendas: contar('vendas'),
    moradores: contar('moradores'),
    lancamentos: contar('lancamentos'),
  };
  db.close();
  return resultado;
}

if (verificar) {
  const pasta = destinoPedido;
  if (!pasta || !fs.existsSync(pasta)) {
    console.error('Informe a pasta da cópia: node scripts/backup.js --verificar backups/2026-11-12');
    process.exit(1);
  }
  const arquivoDb = path.join(pasta, 'mercadinho.db');
  if (!fs.existsSync(arquivoDb)) {
    console.error(`Não achei o banco em ${arquivoDb}.`);
    process.exit(1);
  }
  const r = conferir(arquivoDb);
  const fotos = fs.existsSync(path.join(pasta, 'fotos')) ? fs.readdirSync(path.join(pasta, 'fotos')).length : 0;
  console.log(`Cópia: ${pasta}`);
  console.log(`  banco ....... ${tamanho(arquivoDb)} · integridade: ${r.integridade}`);
  console.log(`  produtos .... ${r.produtos}`);
  console.log(`  vendas ...... ${r.vendas}`);
  console.log(`  moradores ... ${r.moradores}`);
  console.log(`  lançamentos . ${r.lancamentos}`);
  console.log(`  fotos ....... ${fotos}`);
  process.exit(r.integridade === 'ok' ? 0 : 1);
}

if (!fs.existsSync(config.dbFile)) {
  console.error(`Banco não encontrado em ${config.dbFile}. Rode a partir da pasta do sistema, com --env-file=.env.`);
  process.exit(1);
}

const raizDestino = destinoPedido ?? path.join(path.dirname(config.dbFile), '..', 'backups');
const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const destino = path.join(raizDestino, carimbo);
fs.mkdirSync(destino, { recursive: true });

// Banco: VACUUM INTO garante uma cópia inteira e consistente, mesmo com o sistema no ar.
const arquivoDb = path.join(destino, 'mercadinho.db');
const db = new DatabaseSync(config.dbFile, { readOnly: true });
db.exec(`VACUUM INTO '${arquivoDb.replace(/'/g, "''")}'`);
db.close();

// Fotos: arquivos comuns, cópia direta.
let midias = 0;
if (fs.existsSync(config.vitrineDir)) {
  fs.cpSync(config.vitrineDir, path.join(destino, 'vitrine'), { recursive: true });
  midias = fs.readdirSync(path.join(destino, 'vitrine')).length;
}
let fotos = 0;
if (fs.existsSync(config.fotosDir)) {
  fs.cpSync(config.fotosDir, path.join(destino, 'fotos'), { recursive: true });
  fotos = fs.readdirSync(path.join(destino, 'fotos')).length;
}

const conferencia = conferir(arquivoDb);
console.log(`[Mercadinho] Cópia de segurança em ${destino}`);
console.log(`  banco ${tamanho(arquivoDb)} (integridade: ${conferencia.integridade}) · ${conferencia.produtos} produtos · ${conferencia.vendas} vendas · ${fotos} fotos · ${midias} mídias da vitrine`);

// Guarda as cópias dos últimos dias e apaga as mais antigas.
const antigas = fs.readdirSync(raizDestino)
  .filter((nome) => /^\d{4}-\d{2}-\d{2}-/.test(nome))
  .sort()
  .slice(0, -DIAS_PARA_GUARDAR);
for (const nome of antigas) fs.rmSync(path.join(raizDestino, nome), { recursive: true, force: true });
if (antigas.length) console.log(`  ${antigas.length} cópia(s) antiga(s) apagada(s) (guardando as ${DIAS_PARA_GUARDAR} últimas).`);

if (conferencia.integridade !== 'ok') {
  console.error('  ATENÇÃO: a verificação do banco não voltou "ok". Guarde esta cópia e fale com o suporte.');
  process.exit(1);
}
