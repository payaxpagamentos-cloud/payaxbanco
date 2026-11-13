'use strict';

const { agora } = require('../db');
const { normalizar } = require('./regras');

/**
 * Busca na base de conhecimento da empresa. Sem serviço externo e sem embeddings: pontua por palavras
 * em comum, dando mais peso ao título e às perguntas de exemplo do que ao corpo da resposta.
 * Quem decide se o artigo responde de fato é a IA — aqui a gente só traz os candidatos.
 */

// Palavras que não ajudam a distinguir um artigo do outro.
const VAZIAS = new Set(('a o as os um uma uns umas de do da dos das em no na nos nas por para pra pelo pela com sem sob sobre e ou mas que se ao aos à às '
  + 'eu tu ele ela nos vos eles elas me te lhe nos vos lhes meu minha seu sua dele dela isso isto aquilo esse essa este esta aquele aquela '
  + 'ser estar ter haver fazer poder querer ir vir dar ver saber dizer quero preciso gostaria queria pode poderia tem tenho e nao sim '
  + 'como qual quais quando onde quanto quem porque por que oi ola bom dia boa tarde noite obrigado obrigada favor'
).split(/\s+/));

const palavras = (texto) => [...new Set(normalizar(texto).split(' ').filter((p) => p.length >= 3 && !VAZIAS.has(p)))];

/** Radical simples: tira plural e algumas terminações, para "fatura" casar com "faturas". */
const radical = (p) => p.replace(/(coes|oes|aes)$/, 'ao').replace(/(mente|cao|ções|ndo)$/, '').replace(/s$/, '');

const listar = (db, empresaId, { todos = false } = {}) =>
  db.prepare(`SELECT * FROM conhecimento WHERE empresa_id = ?${todos ? '' : ' AND ativo = 1'} ORDER BY titulo`).all(empresaId);

/**
 * Procura os artigos que mais combinam com a pergunta.
 * Devolve [{ id, titulo, resposta, pontos }] do mais relevante para o menos, só acima do mínimo.
 */
function buscar(db, empresaId, pergunta, { limite = 4, minimo = 1 } = {}) {
  const termos = palavras(pergunta).map(radical).filter(Boolean);
  if (!termos.length) return [];
  const artigos = listar(db, empresaId);
  const pontuados = artigos.map((a) => {
    const noTitulo = new Set(palavras(a.titulo).map(radical));
    const nasPerguntas = new Set(palavras(a.perguntas).map(radical));
    const naResposta = new Set(palavras(a.resposta).map(radical));
    let pontos = 0;
    for (const t of termos) {
      if (noTitulo.has(t)) pontos += 3;
      else if (nasPerguntas.has(t)) pontos += 2;
      else if (naResposta.has(t)) pontos += 1;
    }
    // Normaliza pela quantidade de termos da pergunta: pergunta longa não infla a nota.
    return { artigo: a, pontos: Number((pontos / Math.sqrt(termos.length)).toFixed(2)) };
  }).filter((x) => x.pontos >= minimo).sort((a, b) => b.pontos - a.pontos).slice(0, limite);

  return pontuados.map(({ artigo, pontos }) => ({ id: artigo.id, titulo: artigo.titulo, resposta: artigo.resposta, pontos }));
}

/** Marca que o artigo foi usado (o painel mostra os mais e os menos usados). */
function registrarUso(db, ids) {
  for (const id of [].concat(ids ?? [])) db.prepare('UPDATE conhecimento SET usos = usos + 1 WHERE id = ?').run(Number(id));
}

/**
 * Resumo da base para o prompt do sistema: títulos e perguntas de exemplo.
 * Dá à IA a noção do que ela sabe responder, sem despejar a base inteira no prompt.
 */
function indice(db, empresaId, { max = 60 } = {}) {
  return listar(db, empresaId).slice(0, max)
    .map((a) => `- [${a.id}] ${a.titulo}${a.perguntas ? ` (ex.: ${String(a.perguntas).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(' / ')})` : ''}`)
    .join('\n');
}

/** Cria ou atualiza um artigo. */
function salvar(db, empresaId, { id = null, titulo, resposta, perguntas = null, ativo = true }) {
  if (id) {
    db.prepare('UPDATE conhecimento SET titulo = ?, resposta = ?, perguntas = ?, ativo = ?, atualizado_em = ? WHERE id = ? AND empresa_id = ?')
      .run(titulo, resposta, perguntas, ativo ? 1 : 0, agora(), Number(id), empresaId);
    return Number(id);
  }
  return Number(db.prepare('INSERT INTO conhecimento (empresa_id, titulo, resposta, perguntas, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(empresaId, titulo, resposta, perguntas, ativo ? 1 : 0, agora()).lastInsertRowid);
}

module.exports = { buscar, listar, indice, salvar, registrarUso, palavras };
