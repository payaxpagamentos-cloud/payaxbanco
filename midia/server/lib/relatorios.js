'use strict';

const { hoje, somarDias, inicioMes, fimMes, inicioDia } = require('./datas');
const v = require('./validacao');

/**
 * Relatórios do que foi ao ar, a partir do resumo por dia (alimentado pela prova de exibição das TVs).
 *
 * Impactos (pessoas alcançadas, estimativa): fluxo de pessoas do ponto no dia × a fatia do tempo de tela que a
 * campanha ocupou naquele dia. Uma campanha que ficou com 20% do loop de uma padaria de 500 pessoas/dia recebe 100.
 */
const TOTAIS = `WITH tot AS (SELECT data, tela_id, SUM(segundos) AS s FROM resumo_dia WHERE data BETWEEN ? AND ? GROUP BY data, tela_id)`;
const IMPACTOS = 'COALESCE(SUM(CAST(l.publico_dia AS REAL) * r.segundos / NULLIF(tot.s, 0)), 0)';
const JUNCAO = `FROM resumo_dia r JOIN tot ON tot.data = r.data AND tot.tela_id = r.tela_id JOIN locais l ON l.id = r.local_id`;

/** Período pedido (padrão: últimos 30 dias). */
function periodo(q = {}) {
  const ate = q.ate ? v.data(q.ate, 'a data final') : hoje();
  const de = q.de ? v.data(q.de, 'a data inicial') : somarDias(ate, -29);
  v.exigir(de <= ate, 'A data inicial não pode ser depois da final.');
  return { de, ate };
}
const periodoMes = (competencia) => ({ de: inicioMes(competencia), ate: fimMes(competencia) });

const arred = (n) => Math.round(n ?? 0);

/** Por campanha: inserções, tempo no ar, telas e impactos. */
function porCampanha(db, { de, ate, anuncianteId = null, campanhaId = null } = {}) {
  const filtros = [anuncianteId ? 'AND c.anunciante_id = ?' : '', campanhaId ? 'AND c.id = ?' : ''].join(' ');
  const p = [de, ate, de, ate, ...(anuncianteId ? [anuncianteId] : []), ...(campanhaId ? [campanhaId] : [])];
  return db.prepare(`${TOTAIS}
    SELECT c.id AS campanha_id, c.nome AS campanha, c.status, c.cobranca, c.inicio, c.fim, a.id AS anunciante_id, a.nome AS anunciante,
      SUM(r.insercoes) AS insercoes, SUM(r.segundos) AS segundos, COUNT(DISTINCT r.tela_id) AS telas, COUNT(DISTINCT r.local_id) AS pontos,
      ${IMPACTOS} AS impactos
    ${JUNCAO} JOIN campanhas c ON c.id = r.campanha_id JOIN anunciantes a ON a.id = c.anunciante_id
    WHERE r.data BETWEEN ? AND ? AND r.campanha_id <> 0 ${filtros}
    GROUP BY c.id ORDER BY insercoes DESC`).all(...p).map((x) => ({ ...x, impactos: arred(x.impactos) }));
}

/** Por tela: quanto rodou, quanto foi publicidade e quanto foi institucional. */
function porTela(db, { de, ate, localId = null } = {}) {
  const p = [de, ate, de, ate, ...(localId ? [localId] : [])];
  return db.prepare(`${TOTAIS}
    SELECT t.id AS tela_id, t.nome AS tela, t.orientacao, l.id AS local_id, l.nome AS local, l.cidade, l.categoria, l.publico_dia,
      SUM(r.insercoes) AS insercoes, SUM(r.segundos) AS segundos,
      SUM(CASE WHEN r.campanha_id <> 0 THEN r.insercoes ELSE 0 END) AS insercoes_pagas,
      SUM(CASE WHEN r.campanha_id <> 0 THEN r.segundos ELSE 0 END) AS segundos_pagos,
      COUNT(DISTINCT CASE WHEN r.campanha_id <> 0 THEN r.campanha_id END) AS campanhas,
      COUNT(DISTINCT r.data) AS dias
    ${JUNCAO} JOIN telas t ON t.id = r.tela_id
    WHERE r.data BETWEEN ? AND ? ${localId ? 'AND r.local_id = ?' : ''}
    GROUP BY t.id ORDER BY insercoes DESC`).all(...p)
    .map((x) => ({ ...x, ocupacao: x.segundos ? Math.round((x.segundos_pagos / x.segundos) * 1000) / 10 : 0 }));
}

/** Por ponto (comércio): o que o lojista vê e a base do repasse. */
function porLocal(db, { de, ate } = {}) {
  return db.prepare(`${TOTAIS}
    SELECT l.id AS local_id, l.nome AS local, l.cidade, l.uf, l.categoria, l.publico_dia, l.comissao_percentual,
      COUNT(DISTINCT r.tela_id) AS telas, SUM(r.insercoes) AS insercoes, SUM(r.segundos) AS segundos,
      SUM(CASE WHEN r.campanha_id <> 0 THEN r.insercoes ELSE 0 END) AS insercoes_pagas,
      ${IMPACTOS} AS impactos
    ${JUNCAO}
    WHERE r.data BETWEEN ? AND ?
    GROUP BY l.id ORDER BY insercoes DESC`).all(de, ate, de, ate).map((x) => ({ ...x, impactos: arred(x.impactos) }));
}

/** Por dia (gráfico): inserções e tempo no ar. */
function porDia(db, { de, ate, campanhaId = null, telaId = null, anuncianteId = null } = {}) {
  const onde = ['r.data BETWEEN ? AND ?'];
  const p = [de, ate];
  if (campanhaId) { onde.push('r.campanha_id = ?'); p.push(campanhaId); }
  if (telaId) { onde.push('r.tela_id = ?'); p.push(telaId); }
  if (anuncianteId) { onde.push('r.campanha_id IN (SELECT id FROM campanhas WHERE anunciante_id = ?)'); p.push(anuncianteId); }
  return db.prepare(`SELECT r.data, SUM(r.insercoes) AS insercoes, SUM(r.segundos) AS segundos, COUNT(DISTINCT r.tela_id) AS telas
    FROM resumo_dia r WHERE ${onde.join(' AND ')} GROUP BY r.data ORDER BY r.data`).all(...p);
}

/** Inserções por hora do dia (quando a TV mais roda), a partir das exibições. */
function porHora(db, { de, ate, telaId = null } = {}) {
  const horas = db.prepare(`SELECT CAST(strftime('%H', exibida_em) AS INTEGER) AS hora_utc, COUNT(*) AS insercoes
    FROM exibicoes WHERE data BETWEEN ? AND ? ${telaId ? 'AND tela_id = ?' : ''} GROUP BY hora_utc`).all(...[de, ate, ...(telaId ? [telaId] : [])]);
  // As exibições são gravadas em UTC: a hora UTC da meia-noite local dá o deslocamento do fuso.
  const deslocamento = new Date(inicioDia(de)).getUTCHours();
  const porH = Array.from({ length: 24 }, (_, h) => ({ hora: h, insercoes: 0 }));
  for (const r of horas) porH[((r.hora_utc - deslocamento) % 24 + 24) % 24].insercoes += r.insercoes;
  return porH;
}

/** Prova de exibição: uma linha por vez que o criativo foi ao ar. */
function prova(db, { de, ate, campanhaId = null, telaId = null, anuncianteId = null, localId = null, limite = 5000, pagina = 1 } = {}) {
  const onde = ['e.data BETWEEN ? AND ?'];
  const p = [de, ate];
  if (campanhaId) { onde.push('e.campanha_id = ?'); p.push(campanhaId); }
  if (telaId) { onde.push('e.tela_id = ?'); p.push(telaId); }
  if (anuncianteId) { onde.push('e.anunciante_id = ?'); p.push(anuncianteId); }
  if (localId) { onde.push('e.local_id = ?'); p.push(localId); }
  const base = `FROM exibicoes e JOIN telas t ON t.id = e.tela_id JOIN locais l ON l.id = e.local_id
    LEFT JOIN campanhas c ON c.id = e.campanha_id LEFT JOIN anunciantes a ON a.id = e.anunciante_id LEFT JOIN midias m ON m.id = e.midia_id
    WHERE ${onde.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(e.duracao_s), 0) AS segundos ${base}`).get(...p);
  const itens = db.prepare(`SELECT e.exibida_em, e.duracao_s, t.nome AS tela, l.nome AS local, l.cidade, l.uf,
      COALESCE(c.nome, 'Institucional') AS campanha, COALESCE(a.nome, '—') AS anunciante, m.nome AS midia, m.tipo
    ${base} ORDER BY e.exibida_em DESC LIMIT ? OFFSET ?`).all(...p, Math.min(limite, 20000), (pagina - 1) * Math.min(limite, 20000));
  return { de, ate, total: total.n, segundos: total.segundos, itens };
}

/** Texto CSV (separador ;, com BOM para abrir acentuado no Excel). */
function csv(colunas, linhas) {
  const esc = (x) => {
    const s = x === null || x === undefined ? '' : String(x);
    // Evita que o Excel interprete o conteúdo como fórmula.
    const seguro = /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
    return /[;"\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
  };
  return `﻿${[colunas.map(([, t]) => t), ...linhas.map((l) => colunas.map(([k]) => (typeof k === 'function' ? k(l) : l[k])))].map((l) => l.map(esc).join(';')).join('\r\n')}\r\n`;
}

const reais = (c) => ((c ?? 0) / 100).toFixed(2).replace('.', ',');
const dataHoraBr = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: require('../config').fuso }) : '');

function enviarCsv(res, nome, conteudo) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nome}"` });
  res.send(conteudo);
}

const COLUNAS_PROVA = [
  [(l) => dataHoraBr(l.exibida_em), 'Data e hora'], ['tela', 'TV'], ['local', 'Ponto'], ['cidade', 'Cidade'], ['uf', 'UF'],
  ['anunciante', 'Anunciante'], ['campanha', 'Campanha'], ['midia', 'Criativo'], ['tipo', 'Tipo'], ['duracao_s', 'Duração (s)'],
];

module.exports = { periodo, periodoMes, porCampanha, porTela, porLocal, porDia, porHora, prova, csv, reais, dataHoraBr, enviarCsv, COLUNAS_PROVA };
