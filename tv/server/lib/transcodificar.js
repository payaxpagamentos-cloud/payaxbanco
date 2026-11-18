'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const qualidades = require('./qualidades');
const versoes = require('./versoes');
const midia = require('./midia');
const v = require('./validacao');

/**
 * Conversão automática: a operação envia **um** arquivo e o servidor gera as versões
 * menores (Full HD, HD e SD) com o ffmpeg, uma de cada vez, em segundo plano.
 *
 * A fila fica no banco, então o trabalho sobrevive a um reinício: o que ficou pela metade
 * volta para a fila quando o servidor sobe.
 */

// Altura de cada degrau. O arquivo enviado ocupa o seu, e a fila gera os de baixo.
const ALTURAS = { sd: 480, hd: 720, fullhd: 1080, '4k': 2160 };

const equipeConversao = { id: null, nome: 'conversão' };

/** O ffmpeg está instalado nesta máquina? (a resposta é lembrada) */
let temFfmpegCache = null;
function temFfmpeg() {
  if (temFfmpegCache === null) {
    try {
      execFileSync(config.ffmpeg, ['-version'], { stdio: 'ignore' });
      temFfmpegCache = true;
    } catch {
      temFfmpegCache = false;
    }
  }
  return temFfmpegCache;
}

/** Degraus que fazem sentido gerar a partir deste arquivo: só os menores que ele. */
function escada(largura, altura) {
  const doArquivo = qualidades.porMedidas(largura, altura);
  if (!doArquivo) return [];
  return qualidades.ORDEM
    .filter((q) => qualidades.nivel(q) < qualidades.nivel(doArquivo) && ALTURAS[q] < (Number(altura) || 0) - 60);
}

/** O alvo (filme ou episódio) de uma conversão, já conferido. */
function conferirAlvo(db, { tituloId = null, episodioId = null }) {
  if (episodioId) {
    const e = db.prepare('SELECT * FROM episodios WHERE id = ?').get(Number(episodioId));
    if (!e) throw naoEncontrado('Episódio');
    return { tituloId: null, episodioId: e.id };
  }
  const t = db.prepare('SELECT * FROM titulos WHERE id = ?').get(Number(tituloId));
  if (!t) throw naoEncontrado('Título');
  return { tituloId: t.id, episodioId: null };
}

/**
 * Põe na fila as versões que faltam para um filme ou episódio.
 * Devolve o que entrou na fila e o que já existia.
 */
function enfileirar(db, { midiaId, tituloId = null, episodioId = null, qualidadesPedidas = null }) {
  if (!temFfmpeg()) {
    throw new ErroNegocio('Este servidor não tem o ffmpeg instalado, então não converte sozinho. Envie um arquivo por qualidade.', 409, { motivo: 'sem_ffmpeg' });
  }
  const m = midia.buscar(db, v.inteiro(midiaId, 'o vídeo', { min: 1 }));
  if (m.tipo !== 'video' || m.status !== 'pronta') throw new ErroNegocio('O arquivo de origem ainda não está pronto.', 409);
  const alvo = conferirAlvo(db, { tituloId, episodioId });

  const possiveis = escada(m.largura, m.altura);
  const pedidas = qualidadesPedidas?.length
    ? qualidadesPedidas.map((q) => v.opcao(q, 'a qualidade', qualidades.ORDEM)).filter((q) => possiveis.includes(q))
    : possiveis;

  const jaTem = new Set(versoes.listar(db, alvo).map((x) => x.qualidade));
  const naFila = new Set(db.prepare(`SELECT qualidade FROM conversoes WHERE situacao IN ('fila','convertendo')
    AND ${alvo.episodioId ? 'episodio_id' : 'titulo_id'} = ?`).all(alvo.episodioId ?? alvo.tituloId).map((x) => x.qualidade));

  const inserir = db.prepare(`INSERT INTO conversoes (midia_id, titulo_id, episodio_id, qualidade, criado_em) VALUES (?, ?, ?, ?, ?)`);
  const criadas = [];
  const puladas = [];
  for (const q of pedidas) {
    if (jaTem.has(q)) { puladas.push({ qualidade: q, motivo: 'já existe' }); continue; }
    if (naFila.has(q)) { puladas.push({ qualidade: q, motivo: 'já está na fila' }); continue; }
    const r = inserir.run(m.id, alvo.tituloId, alvo.episodioId, q, agora());
    criadas.push(db.prepare('SELECT * FROM conversoes WHERE id = ?').get(Number(r.lastInsertRowid)));
  }
  // A versão do próprio arquivo enviado entra no menu na hora, sem conversão.
  const doArquivo = qualidades.porMedidas(m.largura, m.altura);
  if (doArquivo && !jaTem.has(doArquivo)) versoes.registrar(db, { ...alvo, midiaId: m.id, qualidade: doArquivo });

  tocarFila(db);
  return { criadas, puladas, origem: doArquivo };
}

/** Converte um arquivo para uma altura, avisando o progresso. Devolve o caminho da saída. */
function converter(origem, destino, altura, duracao, aoProgresso) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-y', '-i', origem,
      '-vf', `scale=-2:${altura}`, '-c:v', 'libx264', '-preset', config.conversao.preset, '-crf', String(config.conversao.crf),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats', destino];
    const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let erro = '';
    p.stdout.on('data', (pedaco) => {
      const m = /out_time_ms=(\d+)/.exec(String(pedaco));
      if (m && duracao > 0) aoProgresso(Math.min(99, Math.round((Number(m[1]) / 1e6 / duracao) * 100)));
    });
    p.stderr.on('data', (pedaco) => { erro += String(pedaco).slice(0, 2000); });
    p.on('error', (e) => reject(e));
    p.on('close', (codigo) => (codigo === 0 ? resolve(destino) : reject(new Error(erro.trim() || `ffmpeg terminou com código ${codigo}`))));
  });
}

let rodando = false;

/** Pega o próximo item da fila e converte. Chamada sempre que algo entra na fila. */
function tocarFila(db) {
  if (rodando || !temFfmpeg()) return;
  const job = db.prepare("SELECT * FROM conversoes WHERE situacao = 'fila' ORDER BY id LIMIT 1").get();
  if (!job) return;
  rodando = true;
  processar(db, job)
    .catch((err) => {
      db.prepare("UPDATE conversoes SET situacao = 'erro', erro = ?, concluido_em = ? WHERE id = ?")
        .run(String(err.message).slice(0, 500), agora(), job.id);
    })
    .finally(() => {
      rodando = false;
      // Encadeia o próximo sem empilhar chamadas.
      setTimeout(() => tocarFila(db), 50).unref?.();
    });
}

async function processar(db, job) {
  const m = midia.buscar(db, job.midia_id);
  db.prepare("UPDATE conversoes SET situacao = 'convertendo', progresso = 0 WHERE id = ?").run(job.id);

  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'playtechvip-conv-'));
  const destino = path.join(pasta, `${crypto.randomBytes(5).toString('hex')}.mp4`);
  try {
    await converter(midia.caminho(m), destino, ALTURAS[job.qualidade], m.duracao_s ?? 0, (pct) => {
      db.prepare('UPDATE conversoes SET progresso = ? WHERE id = ?').run(pct, job.id);
    });
    const altura = ALTURAS[job.qualidade];
    const largura = m.largura && m.altura ? Math.round((m.largura / m.altura) * altura / 2) * 2 : null;
    const nova = midia.salvarVideoDeArquivo(db, equipeConversao, destino, {
      nome: `${path.parse(m.nome_original).name}-${job.qualidade}.mp4`,
      duracao_s: m.duracao_s,
      largura,
      altura,
    });
    versoes.registrar(db, {
      tituloId: job.titulo_id,
      episodioId: job.episodio_id,
      midiaId: nova.id,
      qualidade: job.qualidade,
    });
    db.prepare("UPDATE conversoes SET situacao = 'pronta', progresso = 100, saida_midia_id = ?, concluido_em = ? WHERE id = ?")
      .run(nova.id, agora(), job.id);
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

/** Lista a fila para o painel (as últimas primeiro). */
const listar = (db, { limite = 40 } = {}) => db.prepare(`SELECT c.*, t.nome AS titulo_nome, e.nome AS episodio_nome, m.nome_original
  FROM conversoes c
  LEFT JOIN titulos t ON t.id = c.titulo_id
  LEFT JOIN episodios e ON e.id = c.episodio_id
  LEFT JOIN midias m ON m.id = c.midia_id
  ORDER BY c.id DESC LIMIT ?`).all(Number(limite) || 40);

/** Cancela um item que ainda não começou. */
function cancelar(db, id) {
  const c = db.prepare('SELECT * FROM conversoes WHERE id = ?').get(Number(id));
  if (!c) throw naoEncontrado('Conversão');
  if (c.situacao === 'convertendo') throw new ErroNegocio('Esta conversão já começou. Espere terminar.', 409);
  db.prepare("UPDATE conversoes SET situacao = 'cancelada', concluido_em = ? WHERE id = ? AND situacao = 'fila'").run(agora(), c.id);
  return db.prepare('SELECT * FROM conversoes WHERE id = ?').get(c.id);
}

/** Na subida do servidor: o que ficou convertendo quando ele caiu volta para a fila. */
function retomar(db) {
  const voltaram = db.prepare("UPDATE conversoes SET situacao = 'fila', progresso = 0 WHERE situacao = 'convertendo'").run().changes;
  tocarFila(db);
  return voltaram;
}

module.exports = { ALTURAS, temFfmpeg, escada, enfileirar, listar, cancelar, retomar, tocarFila };
