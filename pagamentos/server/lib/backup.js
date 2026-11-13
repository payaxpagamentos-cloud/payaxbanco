'use strict';

/*
 * Backup do banco. Aqui não é higiene de TI: a tabela `lancamentos` é o livro-razão do dinheiro
 * dos clientes — se o arquivo se perder, não existe como reconstruir quanto cada um tem a receber.
 *
 * Por isso cada cópia é CONFERIDA logo depois de gerada: integridade do arquivo e, principalmente,
 * se o total do razão na cópia bate com o do banco em uso. Backup que ninguém conferiu não é backup.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const NOME = /^payax-[\d-]+\.db$/;
const agora = () => new Date().toISOString();

/** Totais do razão, usados para comparar a cópia com o original. */
const totais = (banco) => banco.prepare('SELECT COUNT(*) AS lancamentos, IFNULL(SUM(valor_centavos), 0) AS soma FROM lancamentos').get();

/**
 * Gera a cópia (VACUUM INTO, consistente mesmo com o sistema em uso), confere e registra.
 * @returns {{nome: string, tamanho: number, confere: boolean, integridade: string, divergencia: string|null}}
 */
function gerar(db, { usuario = null, automatico = true, dir = config.backupDir } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let nome = `payax-${carimbo}.db`;
  for (let i = 1; fs.existsSync(path.join(dir, nome)); i++) nome = `payax-${carimbo}-${i}.db`;
  const destino = path.join(dir, nome);

  const esperado = totais(db);
  db.prepare('VACUUM INTO ?').run(destino);

  // Confere a cópia abrindo-a de verdade.
  let integridade = 'não verificada';
  let copia = null;
  let divergencia = null;
  try {
    const c = new DatabaseSync(destino, { readOnly: true });
    integridade = c.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'sem resposta';
    copia = totais(c);
    c.close();
  } catch (err) {
    integridade = `falha ao abrir a cópia: ${err.message}`;
  }

  const confere = integridade === 'ok' && copia !== null
    && copia.lancamentos === esperado.lancamentos && copia.soma === esperado.soma;
  if (!confere) {
    divergencia = integridade !== 'ok'
      ? integridade
      : `o razão da cópia não bate: ${copia?.lancamentos ?? '?'} lançamentos somando ${copia?.soma ?? '?'}, `
        + `contra ${esperado.lancamentos} somando ${esperado.soma} no banco em uso`;
  }

  const tamanho = fs.existsSync(destino) ? fs.statSync(destino).size : 0;
  db.prepare(`INSERT INTO backups (nome, tamanho, integridade, lancamentos, soma_centavos, confere, divergencia, automatico, criado_em, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nome, tamanho, integridade, copia?.lancamentos ?? null, copia?.soma ?? null,
      confere ? 1 : 0, divergencia, automatico ? 1 : 0, agora(), usuario?.id ?? null);

  limpar(db, dir);
  return { nome, tamanho, confere, integridade, divergencia, lancamentos: copia?.lancamentos ?? null };
}

/** Arquivos existentes na pasta, do mais novo para o mais antigo. */
function arquivos(dir = config.backupDir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => NOME.test(n))
    .map((nome) => {
      const st = fs.statSync(path.join(dir, nome));
      return { nome, tamanho: st.size, criado_em: st.mtime.toISOString() };
    })
    .sort((a, b) => b.nome.localeCompare(a.nome));
}

/** Histórico com a conferência, juntando o registro no banco ao arquivo que ainda existe. */
function listar(db, dir = config.backupDir) {
  const naPasta = new Map(arquivos(dir).map((a) => [a.nome, a]));
  const registros = db.prepare('SELECT b.*, u.nome AS criado_por_nome FROM backups b LEFT JOIN usuarios u ON u.id = b.criado_por ORDER BY b.id DESC LIMIT 100').all();
  return registros.map((r) => ({ ...r, disponivel: naPasta.has(r.nome) }));
}

/** Apaga os mais antigos, mantendo os N configurados. O registro no histórico permanece. */
function limpar(db, dir = config.backupDir) {
  for (const a of arquivos(dir).slice(config.backupManter)) {
    fs.rmSync(path.join(dir, a.nome), { force: true });
  }
}

/** Caminho de um backup pelo nome, sem permitir sair da pasta. */
function caminho(nome, dir = config.backupDir) {
  if (!NOME.test(String(nome))) return null;
  const p = path.join(dir, path.basename(String(nome)));
  return fs.existsSync(p) ? p : null;
}

/** Situação para o painel: quando foi o último, se conferiu e se está atrasado. */
function situacao(db, dir = config.backupDir) {
  const ultimo = db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get();
  const horas = ultimo ? (Date.now() - Date.parse(ultimo.criado_em)) / 3_600_000 : null;
  return {
    ultimo: ultimo ? { nome: ultimo.nome, criado_em: ultimo.criado_em, confere: Boolean(ultimo.confere), divergencia: ultimo.divergencia } : null,
    horas_desde: horas === null ? null : Math.round(horas * 10) / 10,
    atrasado: horas === null || horas > config.backupIntervaloHoras * 2,
    arquivos: arquivos(dir).length,
    manter: config.backupManter,
    intervalo_horas: config.backupIntervaloHoras,
  };
}

module.exports = { gerar, listar, arquivos, caminho, limpar, situacao };
