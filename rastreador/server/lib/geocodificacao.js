'use strict';

const config = require('../config');

/**
 * Busca de endereços e endereço de um ponto, pelo Photon (OpenStreetMap; padrão: photon.komoot.io, gratuito, sem chave).
 * As respostas ficam em memória para não repetir a mesma consulta (o ponto de um veículo parado é consultado várias vezes).
 */
const MAX_CACHE = 5000;
const cache = new Map();
const lembrar = (chave, valor) => {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(chave, valor);
  return valor;
};

async function consultar(caminho, params) {
  const url = new URL(`${config.geocoder.url}${caminho}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const resp = await fetch(url, { headers: { 'User-Agent': 'Rastreador de Veiculos', Accept: 'application/json' }, signal: AbortSignal.timeout(config.geocoder.timeoutMs) });
  if (!resp.ok) throw new Error(`Busca de endereços respondeu ${resp.status}`);
  return (await resp.json()).features ?? [];
}

/** Texto do endereço no jeito brasileiro: "Rua X, 123 – Bairro, Cidade – Estado" (e o nome do lugar, quando houver). */
function formatar(f) {
  const p = f.properties ?? {};
  const rua = p.street ? [p.street, p.housenumber].filter(Boolean).join(', ') : (p.osm_key === 'highway' ? p.name : null);
  const lugar = p.name && p.name !== rua && p.osm_key !== 'highway' ? p.name : null;
  const bairro = p.district || p.locality || null;
  const cidade = p.city || p.county || null;
  const regiao = [bairro, cidade].filter((x, i, a) => x && a.indexOf(x) === i).join(', ');
  const fim = [regiao, p.state].filter(Boolean).join(' – ');
  const [lng, lat] = f.geometry?.coordinates ?? [];
  return {
    nome: lugar || rua || bairro || cidade || p.state || 'Local',
    endereco: [lugar ? rua : null, lugar || rua ? fim : [cidade, p.state].filter(Boolean).join(' – ')].filter(Boolean).join(' – ') || null,
    completo: [lugar, rua, fim].filter(Boolean).join(' – '),
    cep: p.postcode ?? null,
    lat, lng,
  };
}

/** Endereços que combinam com o texto (até 6), dando preferência aos perto de `perto` ({ lat, lng }). */
async function buscar(texto, perto) {
  const q = String(texto ?? '').trim().slice(0, 200);
  if (q.length < 3 || !config.geocoder.url) return [];
  const chave = `b|${q.toLowerCase()}|${perto ? `${perto.lat.toFixed(1)},${perto.lng.toFixed(1)}` : ''}`;
  if (cache.has(chave)) return cache.get(chave);
  const f = await consultar('/api/', { q, limit: 6, lang: 'default', lat: perto?.lat, lon: perto?.lng });
  return lembrar(chave, f.map(formatar).filter((x) => Number.isFinite(x.lat)));
}

/** Endereço mais próximo do ponto (arredondado a ~10 m, para o cache servir ao veículo parado). */
async function endereco(lat, lng) {
  if (!config.geocoder.url) return null;
  const chave = `r|${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (cache.has(chave)) return cache.get(chave);
  const f = await consultar('/reverse', { lat: lat.toFixed(6), lon: lng.toFixed(6), limit: 1, lang: 'default' });
  return lembrar(chave, f[0] ? formatar(f[0]) : null);
}

module.exports = { buscar, endereco, formatar };
