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

/** Ponto dentro do polígono [[lat, lng], ...] (cruzamento de raios; as áreas de uma cidade são pequenas o bastante para tratar como plano). */
function dentroPoligono(p, pontos) {
  let dentro = false;
  for (let i = 0, j = pontos.length - 1; i < pontos.length; j = i++) {
    const [yi, xi] = pontos[i];
    const [yj, xj] = pontos[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

/** Ponto dentro da cerca (círculo ou polígono, como gravada no banco). */
function dentroCerca(p, cerca) {
  if (cerca.tipo === 'circulo') return distancia(p, { lat: cerca.lat, lng: cerca.lng }) <= cerca.raio_m;
  const pontos = typeof cerca.pontos === 'string' ? JSON.parse(cerca.pontos) : cerca.pontos;
  return dentroPoligono(p, pontos);
}

module.exports = { distancia, dentroPoligono, dentroCerca };
