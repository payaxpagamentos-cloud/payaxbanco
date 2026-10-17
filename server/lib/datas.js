'use strict';

const FUSO_MS = -3 * 60 * 60 * 1000; // horário de Brasília

/** Data de hoje (AAAA-MM-DD) no horário de Brasília. */
const hoje = (agora = Date.now()) => new Date(agora + FUSO_MS).toISOString().slice(0, 10);

function somarDias(dataIso, dias) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Soma meses mantendo o dia (limitado ao último dia do mês). */
function somarMeses(dataIso, meses) {
  const [a, m, dia] = dataIso.split('-').map(Number);
  const base = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimo = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(dia, ultimo));
  return base.toISOString().slice(0, 10);
}

const diferencaDias = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const mes = (dataIso) => dataIso.slice(0, 7);
const inicioMes = (dataIso) => `${mes(dataIso)}-01`;
const fimMes = (dataIso) => somarDias(somarMeses(inicioMes(dataIso), 1), -1);

/** Lista de meses 'AAAA-MM' entre duas datas (inclusive). */
function meses(de, ate) {
  const lista = [];
  for (let d = inicioMes(de); d <= ate; d = somarMeses(d, 1)) lista.push(mes(d));
  return lista;
}

module.exports = { hoje, somarDias, somarMeses, diferencaDias, mes, inicioMes, fimMes, meses };
