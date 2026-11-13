'use strict';

/** Data 'AAAA-MM-DD' de um instante no fuso da operação. */
function dataLocal(fuso, instante = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instante));
}

function somarDias(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);

/** Diferença (ms) entre o relógio do fuso e o UTC no instante dado. */
function deslocamento(fuso, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
}

/** Instante UTC (ISO) da meia-noite local de 'AAAA-MM-DD' no fuso da operação. */
function inicioDoDia(fuso, data) {
  const [a, m, d] = data.split('-').map(Number);
  const local = Date.UTC(a, m - 1, d);
  let t = local - deslocamento(fuso, local);
  t = local - deslocamento(fuso, t); // segunda passada: acerta a virada de horário de verão
  return new Date(t).toISOString();
}

/** Limites [inicio, fim) de um dia de calendário local, em instantes UTC (ISO), para comparar com carimbos de tempo. */
const limitesDoDia = (fuso, data) => ({ inicio: inicioDoDia(fuso, data), fim: inicioDoDia(fuso, somarDias(data, 1)) });

module.exports = { dataLocal, somarDias, diasEntre, inicioDoDia, limitesDoDia };
