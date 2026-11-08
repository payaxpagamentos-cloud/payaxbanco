'use strict';

const { local, feriado } = require('./datas');

/** Bandeira 2 à noite (início–fim, atravessando a meia-noite), aos domingos e nos feriados nacionais. */
function bandeira(instante, cfg) {
  const l = local(instante);
  const { bandeira2_inicio_hora: ini, bandeira2_fim_hora: fim } = cfg;
  const noite = ini === fim ? false : ini > fim ? l.hora >= ini || l.hora < fim : l.hora >= ini && l.hora < fim;
  if (noite) return 2;
  if (cfg.bandeira2_domingo && l.diaSemana === 0) return 2;
  if (cfg.bandeira2_feriados && feriado(l.data)) return 2;
  return 1;
}

/** Valor da corrida em centavos: bandeirada + quilômetros + minutos, nunca abaixo da mínima. */
function calcular(t, { distancia_m, duracao_s, bandeira: b }) {
  const porKm = b === 2 ? t.km_bandeira2_centavos : t.km_centavos;
  const valor = t.bandeirada_centavos + Math.round((porKm * distancia_m) / 1000) + Math.round((t.minuto_centavos * duracao_s) / 60);
  return Math.max(valor, t.minima_centavos);
}

/** Divide o valor entre a plataforma (taxa em pontos-base) e o motorista. */
function dividir(valor, taxaBp) {
  const taxa = Math.round((valor * taxaBp) / 10_000);
  return { taxa_plataforma_centavos: taxa, valor_motorista_centavos: valor - taxa };
}

module.exports = { bandeira, calcular, dividir };
