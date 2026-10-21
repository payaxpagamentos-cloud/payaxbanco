'use strict';

const { hoje, somarDias, intervalo } = require('./datas');
const v = require('./validacao');

/** Período 'de'/'ate' da query (padrão: os últimos `padraoDias` dias até hoje), limitado a um ano. */
function periodo(q, padraoDias = 0) {
  const ate = q.ate ? v.data(q.ate, 'a data final') : hoje();
  const de = q.de ? v.data(q.de, 'a data inicial') : somarDias(ate, -padraoDias);
  v.exigir(de <= ate && de >= somarDias(ate, -366), 'Período inválido (até um ano).');
  return [de, ate];
}

/**
 * Lista de chamadas com filtros (período, direção, status, ramal, busca por número) e paginação.
 * empresaId nulo: todas as empresas (master), com o nome da empresa.
 */
function listarChamadas(db, empresaId, q, { limite = 100 } = {}) {
  const [de, ate] = periodo(q, 0);
  const [ini, fim] = intervalo(de, ate);
  const onde = ['c.inicio >= ?', 'c.inicio < ?'];
  const p = [ini, fim];
  if (empresaId) { onde.push('c.empresa_id = ?'); p.push(empresaId); }
  else if (q.empresa_id) { onde.push('c.empresa_id = ?'); p.push(Number(q.empresa_id)); }
  if (q.direcao) { onde.push('c.direcao = ?'); p.push(v.opcao(q.direcao, 'a direção', ['entrada', 'saida', 'interna'])); }
  if (q.status) { onde.push('c.status = ?'); p.push(v.opcao(q.status, 'o status', ['em_curso', 'atendida', 'nao_atendida', 'ocupado', 'falha'])); }
  if (q.ramal) { onde.push('r.numero = ?'); p.push(String(q.ramal)); }
  if (q.campanha_id) { onde.push('c.campanha_id = ?'); p.push(Number(q.campanha_id)); }
  if (q.busca) {
    const b = `%${v.digitos(q.busca) || String(q.busca).trim()}%`;
    onde.push('(c.origem LIKE ? OR c.destino LIKE ? OR ct.nome LIKE ?)');
    p.push(b, b, `%${String(q.busca).trim()}%`);
  }
  const pagina = Math.max(1, Number(q.pagina) || 1);
  const base = `FROM chamadas c
    JOIN empresas e ON e.id = c.empresa_id
    LEFT JOIN ramais r ON r.id = c.ramal_id
    LEFT JOIN campanhas cp ON cp.id = c.campanha_id
    LEFT JOIN contatos ct ON ct.empresa_id = c.empresa_id AND ct.telefone = (CASE WHEN c.direcao = 'entrada' THEN c.origem ELSE c.destino END)
    WHERE ${onde.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(c.custo_centavos),0) AS custo_centavos, COALESCE(SUM(c.duracao_s),0) AS duracao_s ${base}`).get(...p);
  const itens = db.prepare(`SELECT c.id, c.uid, c.empresa_id, e.nome AS empresa_nome, c.direcao, c.origem, c.destino, c.tipo_destino, c.status, c.inicio, c.atendida_em,
      c.fim, c.duracao_s, c.tarifado_s, c.custo_centavos, c.gravacao_bytes, r.numero AS ramal, r.nome AS ramal_nome, cp.nome AS campanha, ct.nome AS contato
    ${base} ORDER BY c.inicio DESC, c.id DESC LIMIT ? OFFSET ?`).all(...p, limite, (pagina - 1) * limite);
  return { de, ate, pagina, por_pagina: limite, total: total.n, custo_centavos: total.custo_centavos, duracao_s: total.duracao_s, itens };
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

const COLUNAS_CHAMADAS = [
  ['inicio', 'Início'], ['empresa_nome', 'Empresa'], ['direcao', 'Direção'], ['origem', 'Origem'], ['destino', 'Destino'], ['tipo_destino', 'Tipo'],
  ['ramal', 'Ramal'], ['contato', 'Contato'], ['campanha', 'Campanha'], ['status', 'Status'], ['duracao_s', 'Duração (s)'], ['tarifado_s', 'Tarifado (s)'],
  [(l) => reais(l.custo_centavos), 'Custo (R$)'],
];

function enviarCsv(res, nome, conteudo) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nome}"` });
  res.send(conteudo);
}

module.exports = { periodo, listarChamadas, csv, reais, enviarCsv, COLUNAS_CHAMADAS };
