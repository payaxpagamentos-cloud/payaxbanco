'use strict';

const { lerConfig } = require('../db');
const { intervalo, hoje, inicioMes, local, somarDias } = require('./datas');

/**
 * Os números do atendimento. O indicador que interessa é a **taxa de resolução da ZOE**:
 * de cada 100 conversas, quantas ela fechou sozinha, sem ocupar ninguém da equipe.
 */

const ESCOPO = (empresaId) => (empresaId ? { onde: 'c.empresa_id = ?', args: [empresaId] } : { onde: '1 = 1', args: [] });

/** Resumo do período: volume, resolução pela IA, tempos e satisfação. */
function resumo(db, { empresaId = null, de = hoje(), ate = hoje() } = {}) {
  const [inicio, fim] = intervalo(de, ate);
  const e = ESCOPO(empresaId);
  const args = [...e.args, inicio, fim];

  const base = db.prepare(`SELECT
      COUNT(*) AS conversas,
      SUM(CASE WHEN c.resolvida_por = 'ia' THEN 1 ELSE 0 END) AS resolvidas_ia,
      SUM(CASE WHEN c.resolvida_por = 'cliente' THEN 1 ELSE 0 END) AS resolvidas_cliente,
      SUM(CASE WHEN c.resolvida_por = 'humano' THEN 1 ELSE 0 END) AS resolvidas_humano,
      SUM(CASE WHEN c.resolvida_por = 'abandono' THEN 1 ELSE 0 END) AS abandonadas,
      SUM(CASE WHEN c.transferida_em IS NOT NULL THEN 1 ELSE 0 END) AS transferidas,
      SUM(CASE WHEN c.estado <> 'encerrada' THEN 1 ELSE 0 END) AS em_aberto,
      COUNT(c.csat_nota) AS avaliacoes,
      AVG(c.csat_nota) AS csat_medio,
      SUM(CASE WHEN c.csat_nota >= 4 THEN 1 ELSE 0 END) AS csat_bons
    FROM conversas c WHERE ${e.onde} AND c.aberta_em >= ? AND c.aberta_em < ?`).get(...args);

  const tempos = db.prepare(`SELECT
      AVG(CASE WHEN c.transferida_em IS NOT NULL AND c.assumida_em IS NOT NULL
        THEN (julianday(c.assumida_em) - julianday(c.transferida_em)) * 86400 END) AS espera_fila_s,
      AVG(CASE WHEN c.encerrada_em IS NOT NULL THEN (julianday(c.encerrada_em) - julianday(c.aberta_em)) * 86400 END) AS duracao_s,
      AVG(CASE WHEN c.resolvida_por = 'ia' AND c.encerrada_em IS NOT NULL
        THEN (julianday(c.encerrada_em) - julianday(c.aberta_em)) * 86400 END) AS duracao_ia_s
    FROM conversas c WHERE ${e.onde} AND c.aberta_em >= ? AND c.aberta_em < ?`).get(...args);

  // Primeira resposta da ZOE: o tempo que o cliente espera para ter alguma resposta.
  const primeira = db.prepare(`SELECT AVG(d) AS media_s FROM (
      SELECT (julianday(MIN(m.criada_em)) - julianday(c.aberta_em)) * 86400 AS d
      FROM conversas c JOIN mensagens m ON m.conversa_id = c.id AND m.direcao = 'saida' AND m.tipo <> 'sistema'
      WHERE ${e.onde} AND c.aberta_em >= ? AND c.aberta_em < ? GROUP BY c.id)`).get(...args);

  const conversas = Number(base.conversas) || 0;
  const encerradas = conversas - Number(base.em_aberto ?? 0);
  const resolvidasIa = Number(base.resolvidas_ia ?? 0) + Number(base.resolvidas_cliente ?? 0);
  return {
    periodo: { de, ate },
    conversas,
    em_aberto: Number(base.em_aberto ?? 0),
    encerradas,
    resolvidas_ia: Number(base.resolvidas_ia ?? 0),
    resolvidas_cliente: Number(base.resolvidas_cliente ?? 0),
    resolvidas_humano: Number(base.resolvidas_humano ?? 0),
    abandonadas: Number(base.abandonadas ?? 0),
    transferidas: Number(base.transferidas ?? 0),
    // De cada 100 conversas encerradas, quantas a ZOE fechou sem passar para a equipe.
    taxa_resolucao_ia: encerradas ? Number(((resolvidasIa / encerradas) * 100).toFixed(1)) : 0,
    taxa_transferencia: conversas ? Number(((Number(base.transferidas ?? 0) / conversas) * 100).toFixed(1)) : 0,
    avaliacoes: Number(base.avaliacoes ?? 0),
    csat_medio: base.csat_medio === null ? null : Number(Number(base.csat_medio).toFixed(2)),
    csat_satisfacao: base.avaliacoes ? Number(((Number(base.csat_bons) / Number(base.avaliacoes)) * 100).toFixed(1)) : null,
    primeira_resposta_s: arredondar(primeira?.media_s),
    espera_fila_s: arredondar(tempos?.espera_fila_s),
    duracao_s: arredondar(tempos?.duracao_s),
    duracao_ia_s: arredondar(tempos?.duracao_ia_s),
    ia: custoIa(db, { empresaId, de, ate }),
  };
}

const arredondar = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));

/** Tokens e custo estimado da IA no período, com os preços da plataforma. */
function custoIa(db, { empresaId = null, de = hoje(), ate = hoje() } = {}) {
  const [inicio, fim] = intervalo(de, ate);
  const cfg = lerConfig(db);
  const e = empresaId ? { onde: 'empresa_id = ?', args: [empresaId] } : { onde: '1 = 1', args: [] };
  const r = db.prepare(`SELECT
      SUM(tokens_entrada) AS entrada, SUM(tokens_saida) AS saida, SUM(tokens_cache) AS cache,
      SUM(CASE WHEN tipo = 'resposta' THEN 1 ELSE 0 END) AS respostas,
      SUM(CASE WHEN tipo = 'ferramenta' THEN 1 ELSE 0 END) AS ferramentas,
      SUM(CASE WHEN tipo = 'erro' THEN 1 ELSE 0 END) AS erros,
      AVG(CASE WHEN tipo = 'resposta' THEN ms END) AS ms_medio
    FROM ia_eventos WHERE ${e.onde} AND criado_em >= ? AND criado_em < ?`).get(...e.args, inicio, fim);
  const entrada = Number(r.entrada ?? 0);
  const saida = Number(r.saida ?? 0);
  const cache = Number(r.cache ?? 0);
  return {
    tokens_entrada: entrada,
    tokens_saida: saida,
    tokens_cache: cache,
    respostas: Number(r.respostas ?? 0),
    ferramentas: Number(r.ferramentas ?? 0),
    erros: Number(r.erros ?? 0),
    ms_medio: arredondar(r.ms_medio),
    // Custo estimado em centavos de real, pelos preços que o master cadastrou.
    custo_centavos: Math.round((entrada * cfg.ia_preco_entrada_milhao + saida * cfg.ia_preco_saida_milhao + cache * cfg.ia_preco_cache_milhao) / 1_000_000),
  };
}

/** Série diária: conversas, resolvidas pela IA e transferidas. */
function porDia(db, { empresaId = null, de, ate }) {
  const e = ESCOPO(empresaId);
  const dias = [];
  for (let d = de; d <= ate; d = somarDias(d, 1)) dias.push(d);
  const linhas = new Map(dias.map((d) => [d, { data: d, conversas: 0, resolvidas_ia: 0, transferidas: 0, abandonadas: 0 }]));
  for (const d of dias) {
    const [inicio, fim] = intervalo(d, d);
    const r = db.prepare(`SELECT COUNT(*) AS conversas,
        SUM(CASE WHEN c.resolvida_por IN ('ia','cliente') THEN 1 ELSE 0 END) AS resolvidas_ia,
        SUM(CASE WHEN c.transferida_em IS NOT NULL THEN 1 ELSE 0 END) AS transferidas,
        SUM(CASE WHEN c.resolvida_por = 'abandono' THEN 1 ELSE 0 END) AS abandonadas
      FROM conversas c WHERE ${e.onde} AND c.aberta_em >= ? AND c.aberta_em < ?`).get(...e.args, inicio, fim);
    Object.assign(linhas.get(d), {
      conversas: Number(r.conversas ?? 0), resolvidas_ia: Number(r.resolvidas_ia ?? 0),
      transferidas: Number(r.transferidas ?? 0), abandonadas: Number(r.abandonadas ?? 0),
    });
  }
  return [...linhas.values()];
}

/** Conversas abertas por hora do dia (para dimensionar a equipe). */
function porHora(db, { empresaId = null, de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  const e = ESCOPO(empresaId);
  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, conversas: 0 }));
  for (const c of db.prepare(`SELECT c.aberta_em FROM conversas c WHERE ${e.onde} AND c.aberta_em >= ? AND c.aberta_em < ?`).all(...e.args, inicio, fim)) {
    horas[local(c.aberta_em).hora].conversas++;
  }
  return horas;
}

/** Por que a ZOE transferiu: mostra onde vale investir na base de conhecimento. */
function motivosTransferencia(db, { empresaId = null, de, ate, limite = 15 }) {
  const [inicio, fim] = intervalo(de, ate);
  const e = ESCOPO(empresaId);
  return db.prepare(`SELECT COALESCE(c.motivo_transferencia, '(sem motivo)') AS motivo, COUNT(*) AS conversas,
      COALESCE(f.nome, '(sem fila)') AS fila
    FROM conversas c LEFT JOIN filas f ON f.id = c.fila_id
    WHERE ${e.onde} AND c.transferida_em IS NOT NULL AND c.aberta_em >= ? AND c.aberta_em < ?
    GROUP BY motivo, fila ORDER BY conversas DESC LIMIT ?`).all(...e.args, inicio, fim, limite);
}

/** Desempenho por fila. */
function porFila(db, { empresaId, de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT f.id, f.nome,
      COUNT(c.id) AS conversas,
      SUM(CASE WHEN c.estado = 'aguardando' THEN 1 ELSE 0 END) AS aguardando,
      AVG(CASE WHEN c.assumida_em IS NOT NULL AND c.transferida_em IS NOT NULL THEN (julianday(c.assumida_em) - julianday(c.transferida_em)) * 86400 END) AS espera_s,
      AVG(CASE WHEN c.encerrada_em IS NOT NULL AND c.assumida_em IS NOT NULL THEN (julianday(c.encerrada_em) - julianday(c.assumida_em)) * 86400 END) AS atendimento_s,
      AVG(c.csat_nota) AS csat
    FROM filas f LEFT JOIN conversas c ON c.fila_id = f.id AND c.aberta_em >= ? AND c.aberta_em < ?
    WHERE f.empresa_id = ? GROUP BY f.id ORDER BY f.ordem, f.nome`).all(inicio, fim, empresaId)
    .map((f) => ({ ...f, espera_s: arredondar(f.espera_s), atendimento_s: arredondar(f.atendimento_s), csat: f.csat === null ? null : Number(Number(f.csat).toFixed(2)) }));
}

/** Desempenho por atendente. */
function porAtendente(db, { empresaId, de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT u.id, u.nome, u.disponivel,
      COUNT(c.id) AS atendidas,
      SUM(CASE WHEN c.estado = 'humano' THEN 1 ELSE 0 END) AS em_atendimento,
      AVG(CASE WHEN c.encerrada_em IS NOT NULL AND c.assumida_em IS NOT NULL THEN (julianday(c.encerrada_em) - julianday(c.assumida_em)) * 86400 END) AS atendimento_s,
      AVG(CASE WHEN c.primeira_resposta_humana_em IS NOT NULL AND c.assumida_em IS NOT NULL
        THEN (julianday(c.primeira_resposta_humana_em) - julianday(c.assumida_em)) * 86400 END) AS primeira_resposta_s,
      AVG(c.csat_nota) AS csat, COUNT(c.csat_nota) AS avaliacoes
    FROM usuarios u LEFT JOIN conversas c ON c.atendente_id = u.id AND c.aberta_em >= ? AND c.aberta_em < ?
    WHERE u.empresa_id = ? AND u.perfil IN ('atendente','cliente') AND u.ativo = 1
    GROUP BY u.id ORDER BY atendidas DESC, u.nome`).all(inicio, fim, empresaId)
    .map((a) => ({
      ...a, disponivel: Boolean(a.disponivel), atendimento_s: arredondar(a.atendimento_s),
      primeira_resposta_s: arredondar(a.primeira_resposta_s), csat: a.csat === null ? null : Number(Number(a.csat).toFixed(2)),
    }));
}

/** O que a IA mais fez: ferramentas chamadas e artigos usados. */
function usoDaIa(db, { empresaId, de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  return {
    ferramentas: db.prepare(`SELECT nome, COUNT(*) AS usos FROM ia_eventos
      WHERE empresa_id = ? AND tipo = 'ferramenta' AND criado_em >= ? AND criado_em < ? GROUP BY nome ORDER BY usos DESC`).all(empresaId, inicio, fim),
    intencoes: db.prepare(`SELECT nome, COUNT(*) AS usos FROM ia_eventos
      WHERE empresa_id = ? AND tipo = 'intencao' AND criado_em >= ? AND criado_em < ? GROUP BY nome ORDER BY usos DESC LIMIT 15`).all(empresaId, inicio, fim),
    conhecimento: db.prepare('SELECT id, titulo, usos, ativo FROM conhecimento WHERE empresa_id = ? ORDER BY usos DESC, titulo LIMIT 20').all(empresaId),
    erros: db.prepare(`SELECT nome, detalhe, COUNT(*) AS vezes, MAX(criado_em) AS ultimo FROM ia_eventos
      WHERE empresa_id = ? AND tipo = 'erro' AND criado_em >= ? AND criado_em < ? GROUP BY nome, detalhe ORDER BY vezes DESC LIMIT 10`).all(empresaId, inicio, fim),
  };
}

/** Painel da empresa: o estado de agora mais o resumo de hoje e do mês. */
function painel(db, empresaId) {
  const filas = require('./filas');
  const agoraEstado = db.prepare(`SELECT
      SUM(CASE WHEN estado = 'bot' THEN 1 ELSE 0 END) AS com_ia,
      SUM(CASE WHEN estado = 'aguardando' THEN 1 ELSE 0 END) AS aguardando,
      SUM(CASE WHEN estado = 'humano' THEN 1 ELSE 0 END) AS com_humano
    FROM conversas WHERE empresa_id = ?`).get(empresaId);
  const equipe = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN disponivel = 1 THEN 1 ELSE 0 END) AS disponiveis
    FROM usuarios WHERE empresa_id = ? AND ativo = 1 AND perfil IN ('atendente','cliente')`).get(empresaId);
  return {
    agora: {
      com_ia: Number(agoraEstado.com_ia ?? 0),
      aguardando: Number(agoraEstado.aguardando ?? 0),
      com_humano: Number(agoraEstado.com_humano ?? 0),
      atendentes: Number(equipe.total ?? 0),
      atendentes_disponiveis: Number(equipe.disponiveis ?? 0),
    },
    filas: filas.espera(db, empresaId),
    hoje: resumo(db, { empresaId, de: hoje(), ate: hoje() }),
    mes: resumo(db, { empresaId, de: inicioMes(), ate: hoje() }),
    chamados: db.prepare(`SELECT SUM(CASE WHEN status = 'aberto' THEN 1 ELSE 0 END) AS abertos,
        SUM(CASE WHEN status = 'andamento' THEN 1 ELSE 0 END) AS andamento FROM chamados WHERE empresa_id = ?`).get(empresaId),
  };
}

/** Painel do master: a plataforma inteira e as empresas que mais usam. */
function painelMaster(db) {
  const empresas = db.prepare(`SELECT e.id, e.nome, e.status, e.limite_ia_mes,
      (SELECT COUNT(*) FROM conversas c WHERE c.empresa_id = e.id AND c.estado <> 'encerrada') AS abertas,
      (SELECT COUNT(*) FROM conversas c WHERE c.empresa_id = e.id AND c.aberta_em >= ?) AS conversas_mes,
      (SELECT COUNT(*) FROM ia_eventos i WHERE i.empresa_id = e.id AND i.tipo = 'resposta' AND i.criado_em >= ?) AS ia_mes,
      (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id AND u.ativo = 1 AND u.perfil IN ('atendente','cliente')) AS atendentes,
      (SELECT COUNT(*) FROM numeros n WHERE n.empresa_id = e.id AND n.ativo = 1) AS numeros
    FROM empresas e WHERE e.status <> 'excluida' ORDER BY conversas_mes DESC, e.nome`)
    .all(...[intervalo(inicioMes(), hoje())[0], intervalo(inicioMes(), hoje())[0]]);
  return {
    empresas,
    totais: {
      empresas_ativas: empresas.filter((e) => e.status === 'ativa').length,
      conversas_abertas: empresas.reduce((s, e) => s + Number(e.abertas), 0),
      conversas_mes: empresas.reduce((s, e) => s + Number(e.conversas_mes), 0),
      atendentes: empresas.reduce((s, e) => s + Number(e.atendentes), 0),
    },
    hoje: resumo(db, { de: hoje(), ate: hoje() }),
    mes: resumo(db, { de: inicioMes(), ate: hoje() }),
  };
}

/** CSV de conversas do período (para a planilha do cliente). */
function csvConversas(db, { empresaId, de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  const linhas = db.prepare(`SELECT c.id, c.aberta_em, c.encerrada_em, ct.telefone, COALESCE(ct.nome, ct.nome_perfil, '') AS nome,
      COALESCE(c.assunto, '') AS assunto, COALESCE(c.intencao, '') AS intencao, c.estado, COALESCE(c.resolvida_por, '') AS resolvida_por,
      COALESCE(f.nome, '') AS fila, COALESCE(u.nome, '') AS atendente, COALESCE(c.motivo_transferencia, '') AS motivo, c.mensagens_ia,
      COALESCE(c.csat_nota, '') AS csat
    FROM conversas c JOIN contatos ct ON ct.id = c.contato_id
    LEFT JOIN filas f ON f.id = c.fila_id LEFT JOIN usuarios u ON u.id = c.atendente_id
    WHERE c.empresa_id = ? AND c.aberta_em >= ? AND c.aberta_em < ? ORDER BY c.id`).all(empresaId, inicio, fim);
  const cab = ['id', 'aberta_em', 'encerrada_em', 'telefone', 'nome', 'assunto', 'intencao', 'estado', 'resolvida_por', 'fila', 'atendente', 'motivo', 'mensagens_ia', 'csat'];
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cab.join(';'), ...linhas.map((l) => cab.map((k) => escapar(l[k])).join(';'))].join('\n');
}

module.exports = { resumo, custoIa, porDia, porHora, motivosTransferencia, porFila, porAtendente, usoDaIa, painel, painelMaster, csvConversas };
