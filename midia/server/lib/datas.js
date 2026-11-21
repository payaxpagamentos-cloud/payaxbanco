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
    hhmm: `${p.hour}:${p.minute}`,
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

const mes = (data = hoje()) => data.slice(0, 7);
const inicioMes = (competencia = mes()) => `${competencia.slice(0, 7)}-01`;
/** Último dia do mês da competência ('AAAA-MM'). */
function fimMes(competencia = mes()) {
  const [a, m] = competencia.slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}
const diasNoMes = (competencia = mes()) => Number(fimMes(competencia).slice(8));
function somarMeses(competencia, n) {
  const [a, m] = competencia.slice(0, 7).split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
/** Dias do período da campanha que caem na competência (para proporcionalizar a mensalidade). */
function diasNaCompetencia(competencia, inicio, fim) {
  const de = inicioMes(competencia) > inicio ? inicioMes(competencia) : inicio;
  const ate = !fim || fim > fimMes(competencia) ? fimMes(competencia) : fim;
  if (de > ate) return 0;
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1;
}

/** Minutos desde a meia-noite de 'HH:MM'. */
const minutosDe = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** A hora local está dentro da janela [inicio, fim)? Janelas que viram a madrugada (22:00–02:00) são aceitas. */
function dentroDaJanela(hhmm, inicio, fim) {
  const [m, i, f] = [minutosDe(hhmm), minutosDe(inicio), minutosDe(fim)];
  if (i === f) return true; // 24 horas
  return i < f ? m >= i && m < f : m >= i || m < f;
}

module.exports = { local, hoje, somarDias, inicioDia, intervalo, mes, inicioMes, fimMes, diasNoMes, somarMeses, diasNaCompetencia, minutosDe, dentroDaJanela };
