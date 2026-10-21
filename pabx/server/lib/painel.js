'use strict';

const { hoje, intervalo, inicioMes, local } = require('./datas');
const { simultaneas, manutencao } = require('./chamadas');

/** Filtro "de uma empresa" ou "de todas" (empresaId nulo, visão do master). */
const deEmpresa = (empresaId, col = 'empresa_id') => (empresaId ? [`${col} = ?`, [empresaId]] : ['1 = 1', []]);

/**
 * Números do dashboard (de uma empresa ou da plataforma inteira):
 * utilização de hoje e do mês, chamadas simultâneas de hoje, ramais online, uso do mês por tipo de destino e TTS/STT.
 */
function dashboard(db, empresaId = null) {
  manutencao(db);
  const [filtro, p] = deEmpresa(empresaId);
  const [iniHoje, fimHoje] = intervalo(hoje(), hoje());
  const [iniMes] = intervalo(inicioMes(), hoje());

  const periodo = (ini) => db.prepare(`SELECT
      COALESCE(SUM(direcao = 'entrada'), 0) AS recebidas,
      COALESCE(SUM(direcao = 'saida'), 0) AS realizadas,
      COALESCE(SUM(direcao = 'interna'), 0) AS internas,
      COALESCE(SUM(direcao = 'entrada' AND status = 'atendida'), 0) AS recebidas_atendidas,
      COALESCE(SUM(status = 'atendida'), 0) AS atendidas,
      COALESCE(SUM(CASE WHEN direcao = 'saida' THEN custo_centavos END), 0) AS gastos_centavos,
      COALESCE(SUM(duracao_s), 0) AS duracao_s
    FROM chamadas WHERE ${filtro} AND inicio >= ? AND inicio < ?`).get(...p, ini, fimHoje);

  const passo = 15 * 60_000;
  const doDia = db.prepare(`SELECT inicio, fim FROM chamadas WHERE ${filtro} AND inicio < ? AND (fim IS NULL OR fim >= ?)`).all(...p, fimHoje, iniHoje);
  const ini = Date.parse(iniHoje);
  const pico = simultaneas(doDia, ini, Date.parse(fimHoje), passo);

  const ramais = db.prepare(`SELECT COALESCE(SUM(online = 1), 0) AS online, COUNT(*) AS total FROM ramais WHERE ${filtro} AND ativo = 1`).get(...p);
  const usoMes = Object.fromEntries(db.prepare(`SELECT tipo_destino, COUNT(*) AS chamadas, COALESCE(SUM(tarifado_s),0) AS tarifado_s, COALESCE(SUM(custo_centavos),0) AS custo_centavos
    FROM chamadas WHERE ${filtro} AND direcao = 'saida' AND inicio >= ? AND inicio < ? GROUP BY tipo_destino`).all(...p, iniMes, fimHoje)
    .map((x) => [x.tipo_destino, { chamadas: x.chamadas, tarifado_s: x.tarifado_s, custo_centavos: x.custo_centavos }]));
  const recursos = Object.fromEntries(db.prepare(`SELECT recurso, SUM(quantidade) AS usado FROM uso_recursos WHERE ${filtro} AND criado_em >= ? GROUP BY recurso`)
    .all(...p, iniMes).map((x) => [x.recurso, x.usado]));
  const limites = empresaId
    ? db.prepare('SELECT tts_limite, stt_limite FROM empresas WHERE id = ?').get(empresaId)
    : db.prepare("SELECT COALESCE(SUM(tts_limite),0) AS tts_limite, COALESCE(SUM(stt_limite),0) AS stt_limite FROM empresas WHERE status <> 'excluida'").get();

  return {
    utilizacao: { hoje: periodo(iniHoje), mes: periodo(iniMes) },
    em_curso: db.prepare(`SELECT COUNT(*) AS n FROM chamadas WHERE ${filtro} AND fim IS NULL`).get(...p).n,
    simultaneas: { inicio: iniHoje, passo_min: passo / 60_000, pontos: pico, pico: Math.max(0, ...pico.filter((x) => x !== null)) },
    ramais: { online: ramais.online, offline: ramais.total - ramais.online, total: ramais.total },
    uso_mes: usoMes,
    recursos: {
      tts: { usado: recursos.tts ?? 0, limite: limites.tts_limite },
      stt: { usado: recursos.stt ?? 0, limite: limites.stt_limite },
    },
  };
}

/** Relatório do período: totais por dia, por tipo de destino e por ramal (ou por empresa, na visão do master). */
function relatorio(db, empresaId, de, ate) {
  const [filtro, p] = deEmpresa(empresaId, 'c.empresa_id');
  const [ini, fim] = intervalo(de, ate);
  const somas = `COUNT(*) AS chamadas, COALESCE(SUM(c.direcao = 'entrada'),0) AS recebidas, COALESCE(SUM(c.direcao = 'saida'),0) AS realizadas,
    COALESCE(SUM(c.status = 'atendida'),0) AS atendidas, COALESCE(SUM(c.status <> 'atendida' AND c.fim IS NOT NULL),0) AS perdidas,
    COALESCE(SUM(c.duracao_s),0) AS duracao_s, COALESCE(SUM(c.tarifado_s),0) AS tarifado_s, COALESCE(SUM(c.custo_centavos),0) AS custo_centavos`;
  const onde = `${filtro} AND c.inicio >= ? AND c.inicio < ?`;
  const q = (sql) => db.prepare(sql).all(...p, ini, fim);
  // Dia local (no fuso configurado) de cada chamada: calculado em JS para não depender do fuso do SQLite.
  const porDia = new Map();
  for (const c of db.prepare(`SELECT c.inicio, c.direcao, c.status, c.fim, c.duracao_s, c.tarifado_s, c.custo_centavos FROM chamadas c WHERE ${onde}`).all(...p, ini, fim)) {
    const dia = local(c.inicio).data;
    const t = porDia.get(dia) ?? { dia, chamadas: 0, recebidas: 0, realizadas: 0, atendidas: 0, perdidas: 0, duracao_s: 0, tarifado_s: 0, custo_centavos: 0 };
    t.chamadas++;
    if (c.direcao === 'entrada') t.recebidas++;
    if (c.direcao === 'saida') t.realizadas++;
    if (c.status === 'atendida') t.atendidas++;
    else if (c.fim) t.perdidas++;
    t.duracao_s += c.duracao_s;
    t.tarifado_s += c.tarifado_s;
    t.custo_centavos += c.custo_centavos;
    porDia.set(dia, t);
  }
  return {
    de, ate,
    total: db.prepare(`SELECT ${somas} FROM chamadas c WHERE ${onde}`).get(...p, ini, fim),
    por_dia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    por_tipo: q(`SELECT c.tipo_destino, ${somas} FROM chamadas c WHERE ${onde} AND c.direcao = 'saida' GROUP BY c.tipo_destino ORDER BY custo_centavos DESC`),
    por_ramal: empresaId ? q(`SELECT r.numero, r.nome, ${somas} FROM chamadas c JOIN ramais r ON r.id = c.ramal_id WHERE ${onde}
      GROUP BY r.id ORDER BY chamadas DESC LIMIT 200`) : undefined,
    por_empresa: empresaId ? undefined : q(`SELECT e.id, e.nome, ${somas} FROM chamadas c JOIN empresas e ON e.id = c.empresa_id WHERE ${onde}
      GROUP BY e.id ORDER BY custo_centavos DESC LIMIT 500`),
  };
}

module.exports = { dashboard, relatorio, deEmpresa };
