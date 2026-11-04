'use strict';

const config = require('../config');

/**
 * Busca de endereços (Photon) e endereço de um ponto (Nominatim para a rua, Photon para o bairro), ambos do OpenStreetMap,
 * gratuitos e sem chave. O Nominatim mede a distância até o traçado da rua (o Photon mede até o meio dela e, numa rua comprida,
 * escolhe a vizinha). As respostas ficam em memória para não repetir a mesma consulta.
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

// O Nominatim aceita no máximo 1 consulta por segundo: as consultas entram numa fila.
let filaNominatim = Promise.resolve();
const INTERVALO_NOMINATIM_MS = 1100;
function nominatim(lat, lng) {
  const vez = filaNominatim.then(async () => {
    const url = new URL(`${config.geocoder.reverso}/reverse`);
    for (const [k, v] of Object.entries({ lat: lat.toFixed(6), lon: lng.toFixed(6), format: 'jsonv2', zoom: 18, addressdetails: 1, 'accept-language': 'pt-BR' })) {
      url.searchParams.set(k, String(v));
    }
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Rastreador de Veiculos', Accept: 'application/json' }, signal: AbortSignal.timeout(config.geocoder.timeoutMs) });
      return resp.ok ? await resp.json() : null;
    } finally {
      await new Promise((r) => setTimeout(r, INTERVALO_NOMINATIM_MS));
    }
  });
  filaNominatim = vez.catch(() => {});
  return vez;
}

/** Junta a rua (e o número, se o mapa tiver) do Nominatim com o bairro do Photon. */
function juntar(n, bairroPhoton, cidadePhoton, lat, lng) {
  const a = n.address ?? {};
  const rua = a.road ? [a.road, a.house_number].filter(Boolean).join(', ') : null;
  const bairro = bairroPhoton || a.suburb || a.city_district || a.neighbourhood || null;
  const cidade = a.city || a.town || a.village || cidadePhoton || null;
  const regiao = [bairro, cidade].filter((x, i, l) => x && l.indexOf(x) === i).join(', ');
  const fim = [regiao, a.state].filter(Boolean).join(' – ');
  const lugar = n.name && n.name !== a.road ? n.name : null;
  return {
    nome: lugar || rua || bairro || cidade || 'Local',
    endereco: [lugar ? rua : null, fim].filter(Boolean).join(' – ') || null,
    completo: [lugar, rua, fim].filter(Boolean).join(' – '),
    cep: a.postcode ?? null,
    lat, lng,
  };
}

/** Endereço do ponto (arredondado a ~10 m, para o cache servir ao veículo parado). Sem o Nominatim, usa só o Photon. */
async function endereco(lat, lng) {
  if (!config.geocoder.url && !config.geocoder.reverso) return null;
  const chave = `r|${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (cache.has(chave)) return cache.get(chave);
  const [n, f] = await Promise.all([
    config.geocoder.reverso ? nominatim(lat, lng).catch(() => null) : null,
    config.geocoder.url ? consultar('/reverse', { lat: lat.toFixed(6), lon: lng.toFixed(6), limit: 1, lang: 'default' }).catch(() => []) : [],
  ]);
  const photon = f[0] ? formatar(f[0]) : null;
  if (n?.address) {
    const p = f[0]?.properties ?? {};
    return lembrar(chave, juntar(n, p.district || p.locality || null, p.city || null, lat, lng));
  }
  if (!photon && !n) throw new Error('Nenhum serviço de endereço respondeu');
  return lembrar(chave, photon);
}

module.exports = { buscar, endereco, formatar };
