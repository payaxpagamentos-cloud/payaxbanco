'use strict';

const config = require('../config');

const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short', hourCycle: 'h23',
});

/** Data ('AAAA-MM-DD'), hora e dia da semana (0 = domingo) no fuso configurado. */
function local(instante = new Date()) {
  const p = Object.fromEntries(formatador.formatToParts(new Date(instante)).map((x) => [x.type, x.value]));
  return {
    data: `${p.year}-${p.month}-${p.day}`,
    hora: Number(p.hour),
    minuto: Number(p.minute),
    segundo: Number(p.second),
    diaSemana: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

const hoje = () => local().data;

function somarDias(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Instante UTC (ISO) em que começa o dia local informado. */
function inicioDia(data) {
  const meioDia = Date.parse(`${data}T12:00:00Z`);
  const l = local(meioDia);
  const comoUtc = Date.UTC(...l.data.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)), l.hora, l.minuto, l.segundo);
  const deslocamento = comoUtc - meioDia; // local - UTC
  return new Date(Date.parse(`${data}T00:00:00Z`) - deslocamento).toISOString();
}

/** Intervalo [início, fim) em ISO UTC dos dias locais de..até (inclusive). */
const intervalo = (de, ate) => [inicioDia(de), inicioDia(somarDias(ate, 1))];

const inicioMes = (data = hoje()) => `${data.slice(0, 7)}-01`;

module.exports = { local, hoje, somarDias, inicioDia, intervalo, inicioMes };
