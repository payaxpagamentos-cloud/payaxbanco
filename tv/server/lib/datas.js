'use strict';

const config = require('../config');

const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Data ('AAAA-MM-DD') e hora no fuso da operação. */
function local(instante = new Date()) {
  const p = Object.fromEntries(formatador.formatToParts(new Date(instante)).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour), minuto: Number(p.minute), segundo: Number(p.second) };
}

const hoje = () => local().data;
const competencia = (data = hoje()) => data.slice(0, 7);

function somarDias(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function somarMeses(data, n) {
  const [a, m, d] = data.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1, 12));
  // Mantém o dia quando existe no mês de destino (31/01 + 1 mês = 28/02).
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0, 12)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}

/** Instante UTC (ISO) em que começa o dia local informado. */
function inicioDia(data) {
  const meioDia = Date.parse(`${data}T12:00:00Z`);
  const l = local(meioDia);
  const comoUtc = Date.UTC(...l.data.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)), l.hora, l.minuto, l.segundo);
  return new Date(Date.parse(`${data}T00:00:00Z`) - (comoUtc - meioDia)).toISOString();
}

/** Diferença, em horas, entre o fuso da operação e o UTC (ex.: -3 em São Paulo). */
function deslocamentoHoras(instante = new Date()) {
  const t = new Date(instante);
  const l = local(t);
  const [a, m, dia] = l.data.split('-').map(Number);
  const comoUtc = Date.UTC(a, m - 1, dia, l.hora, l.minuto, l.segundo);
  return Math.round((comoUtc - Math.floor(t.getTime() / 1000) * 1000) / 3_600_000);
}

/** Intervalo [início, fim) em ISO UTC dos dias locais de..até (inclusive). */
const intervalo = (de, ate) => [inicioDia(de), inicioDia(somarDias(ate, 1))];

module.exports = { local, hoje, competencia, somarDias, somarMeses, inicioDia, intervalo, deslocamentoHoras };
