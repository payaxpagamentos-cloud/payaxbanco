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
const diaSemana = (data) => new Date(`${data}T12:00:00Z`).getUTCDay(); // 0 = domingo

/** Domingo de Páscoa do ano (algoritmo de Meeus/Jones/Butcher), em UTC. */
function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const cacheFeriados = new Map();

/**
 * Feriados nacionais do ano (os bancários: não há expediente, então não há crédito nem compensação).
 * Feriados municipais e estaduais não entram — se a operação precisar, cadastre em `parametros`.
 */
function feriados(ano) {
  if (cacheFeriados.has(ano)) return cacheFeriados.get(ano);
  const iso = (d) => d.toISOString().slice(0, 10);
  const mover = (base, dias) => iso(new Date(base.getTime() + dias * 86400_000));
  const p = pascoa(ano);
  const lista = new Set([
    `${ano}-01-01`, // Confraternização Universal
    `${ano}-04-21`, // Tiradentes
    `${ano}-05-01`, // Dia do Trabalho
    `${ano}-09-07`, // Independência
    `${ano}-10-12`, // Nossa Senhora Aparecida
    `${ano}-11-02`, // Finados
    `${ano}-11-15`, // Proclamação da República
    `${ano}-11-20`, // Consciência Negra (feriado nacional desde 2024)
    `${ano}-12-25`, // Natal
    mover(p, -48), // Segunda-feira de Carnaval
    mover(p, -47), // Terça-feira de Carnaval
    mover(p, -2), // Sexta-feira Santa
    mover(p, 60), // Corpus Christi
  ]);
  cacheFeriados.set(ano, lista);
  return lista;
}

/** Dia útil bancário: de segunda a sexta, fora dos feriados nacionais. */
function ehDiaUtil(data) {
  const s = diaSemana(data);
  return s !== 0 && s !== 6 && !feriados(Number(data.slice(0, 4))).has(data);
}

/** Próximo dia útil (o próprio, se já for). */
function proximoDiaUtil(data) {
  let d = data;
  for (let i = 0; i < 15 && !ehDiaUtil(d); i++) d = somarDias(d, 1);
  return d;
}

/** Soma `n` dias úteis: D+0 é o próprio dia (ou o próximo útil, se cair em fim de semana/feriado). */
function somarDiasUteis(data, n) {
  let d = proximoDiaUtil(data);
  for (let i = 0; i < n; i++) d = proximoDiaUtil(somarDias(d, 1));
  return d;
}

const primeiroDiaMes = (data) => `${data.slice(0, 7)}-01`;
const ultimoDiaMes = (data) => {
  const [a, m] = data.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
};

module.exports = { dataLocal, somarDias, diasEntre, diaSemana, ehDiaUtil, proximoDiaUtil, somarDiasUteis, feriados, pascoa, primeiroDiaMes, ultimoDiaMes };
