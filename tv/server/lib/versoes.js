'use strict';

const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const qualidades = require('./qualidades');
const v = require('./validacao');

/**
 * Versões de um mesmo conteúdo em qualidades diferentes.
 *
 * O título (ou o episódio) continua apontando para a versão principal em video_midia_id —
 * é a que toca por padrão quando o plano permite. As outras ficam aqui, e o player troca
 * entre elas sem perder a posição.
 */

const COLUNAS = `v.id, v.qualidade, v.midia_id, m.mime, m.tamanho, m.duracao_s, m.largura, m.altura, m.status`;

/** Todas as versões prontas de um filme (tituloId) ou de um episódio (episodioId). */
function listar(db, { tituloId = null, episodioId = null }) {
  const onde = episodioId ? 'v.episodio_id = ?' : 'v.titulo_id = ?';
  return db.prepare(`SELECT ${COLUNAS} FROM versoes v JOIN midias m ON m.id = v.midia_id
    WHERE ${onde} AND m.tipo = 'video' AND m.status = 'pronta'`).all(Number(episodioId ?? tituloId));
}

/**
 * Monta o menu de qualidades: junta a versão principal com as cadastradas, em ordem,
 * e marca as que o plano do assinante não alcança.
 */
function menu(db, { tituloId = null, episodioId = null, principal, limitePlano }) {
  const porMidia = new Map();
  const guardar = (linha, qualidade) => {
    const atual = porMidia.get(linha.midia_id ?? linha.id);
    const q = qualidade ?? qualidades.porMedidas(linha.largura, linha.altura) ?? 'hd';
    if (!atual || qualidades.nivel(q) > qualidades.nivel(atual.qualidade)) {
      porMidia.set(linha.midia_id ?? linha.id, {
        midia_id: linha.midia_id ?? linha.id,
        qualidade: q,
        mime: linha.mime,
        tamanho: linha.tamanho,
        duracao_s: linha.duracao_s,
        largura: linha.largura,
        altura: linha.altura,
      });
    }
  };

  if (principal) guardar(principal, principal.qualidade);
  for (const linha of listar(db, { tituloId, episodioId })) guardar(linha, linha.qualidade);

  // Uma qualidade por linha do menu: se duas versões derem na mesma, fica a de arquivo maior.
  const porQualidade = new Map();
  for (const item of porMidia.values()) {
    const atual = porQualidade.get(item.qualidade);
    if (!atual || (item.tamanho ?? 0) > (atual.tamanho ?? 0)) porQualidade.set(item.qualidade, item);
  }

  const lista = [...porQualidade.values()]
    .map((item) => ({ ...item, bloqueada: !qualidades.cabeNoPlano(item.qualidade, limitePlano) }))
    .sort((a, b) => qualidades.nivel(b.qualidade) - qualidades.nivel(a.qualidade));

  // A melhor que o plano alcança toca por padrão; se o plano não alcança nenhuma, toca a menor.
  const liberadas = lista.filter((x) => !x.bloqueada);
  const escolhida = liberadas[0] ?? lista[lista.length - 1] ?? null;
  return { lista, escolhida };
}

/** Cadastra (ou troca) a versão de uma qualidade. */
function registrar(db, { tituloId = null, episodioId = null, midiaId, qualidade }) {
  const q = v.opcao(qualidade, 'a qualidade', qualidades.ORDEM);
  const m = db.prepare("SELECT * FROM midias WHERE id = ? AND tipo = 'video'").get(Number(midiaId));
  if (!m) throw naoEncontrado('Vídeo');
  if (m.status !== 'pronta') throw new ErroNegocio('Este arquivo ainda está sendo enviado.', 409);
  const onde = episodioId ? 'episodio_id = ?' : 'titulo_id = ?';
  const alvo = Number(episodioId ?? tituloId);
  // Uma versão por qualidade: a nova toma o lugar da anterior.
  db.prepare(`DELETE FROM versoes WHERE ${onde} AND qualidade = ?`).run(alvo, q);
  const r = db.prepare('INSERT INTO versoes (titulo_id, episodio_id, midia_id, qualidade, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(tituloId ?? null, episodioId ?? null, m.id, q, agora());
  return db.prepare('SELECT * FROM versoes WHERE id = ?').get(Number(r.lastInsertRowid));
}

const remover = (db, id) => db.prepare('DELETE FROM versoes WHERE id = ?').run(Number(id)).changes;

module.exports = { listar, menu, registrar, remover };
