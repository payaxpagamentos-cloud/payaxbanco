'use strict';

const RAIO_TERRA_M = 6_371_000;
const rad = (g) => (g * Math.PI) / 180;

/** Distância em linha reta (metros) entre dois pontos { lat, lng }. */
function distancia(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RAIO_TERRA_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimativa por ruas: linha reta × fator de rota; tempo pela velocidade média. */
function estimarRota(a, b, { fator_rota, velocidade_media_kmh }) {
  const metros = Math.round(distancia(a, b) * fator_rota);
  const segundos = Math.round(metros / ((velocidade_media_kmh * 1000) / 3600));
  return { distancia_m: metros, duracao_s: segundos };
}

module.exports = { distancia, estimarRota };
