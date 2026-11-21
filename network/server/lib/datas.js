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

/** Data 'AAAA-MM-DD' como 18/08/2026, para mensagens e históricos que a pessoa lê. */
const dataBr = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
/** Competência 'AAAA-MM' como 08/2026. */
const competenciaBr = (c) => (c ? `${String(c).slice(5, 7)}/${String(c).slice(0, 4)}` : '—');

module.exports = { dataLocal, somarDias, diasEntre, dataBr, competenciaBr };
